import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Project,
  Client,
  Quote,
  InventoryItem,
  StudioSettings,
  TeamMember,
  Task,
  Proof,
  ProofFeedback,
  ProjectType,
  PriceCatalogItem,
  FinancialRecord,
} from '../types';
import {
  buildDefaultTasks,
  generateId,
  generatePortalPassword,
  DEFAULT_PRICE_CATALOG,
  DEFAULT_FINANCIAL_RECORDS,
  DEFAULT_CLIENTS,
  DEFAULT_PROJECTS,
  DEFAULT_QUOTES,
  DEFAULT_INVENTORY,
} from '../lib/constants';
import { computeBackwardPlans, TODAY_ISO, addDays, ComputedPlannerResult } from '../lib/plannerEngine';
import {
  db,
  auth,
  loginWithGoogle,
  logoutUser,
  onAuthStateChanged,
  User,
  testConnection,
  handleFirestoreError,
  OperationType,
  firebaseConfig,
} from '../lib/firebase';
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  getDocs,
} from 'firebase/firestore';
import { saveRemoteStudioData, fetchRemoteStudioData, isSupabaseConfigured, initSupabase } from '../lib/supabase';

const LOCAL_STORAGE_KEY = 'sage_paper_studio_manager_v2';
const SYNC_CHANNEL_NAME = 'sage_paper_studio_sync_channel';

const DEFAULT_SETTINGS: StudioSettings = {
  ownerHours: 30, // Giulia weekly capacity
  collabHours: 4,  // Claudia weekly capacity
  buffer: 20,      // 20% safety buffer
  vat: 22,         // 22% VAT
  deposit: 40,     // 40% deposit
  gcalSyncEnabled: false,
  gcalCalendarId: 'primary',
};

const DEFAULT_TEAM: TeamMember[] = [
  {
    id: 'tm_giulia',
    name: 'Giulia',
    role: 'Titolare, Design & Calligrafia',
    weeklyHours: 30,
    avatar: 'G',
    color: '#244d3b',
    active: true,
  },
  {
    id: 'tm_claudia',
    name: 'Claudia',
    role: 'Confezionamento & Logistica',
    weeklyHours: 4,
    avatar: 'C',
    color: '#c48b71',
    active: true,
  },
];

interface StudioContextType {
  projects: Project[];
  clients: Client[];
  quotes: Quote[];
  inventory: InventoryItem[];
  priceCatalog: PriceCatalogItem[];
  financials: FinancialRecord[];
  settings: StudioSettings;
  teamMembers: TeamMember[];
  plannerResult: ComputedPlannerResult;
  dbStatus: 'connected' | 'local_fallback' | 'error';
  isSyncing: boolean;
  lastSyncedAt: string | null;
  currentUser: User | null;
  loginWithGoogle: () => Promise<User>;
  logoutUser: () => Promise<void>;
  firebaseConfig: typeof firebaseConfig;

  // Project Actions
  createProject: (data: Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'tasks'> & { tasks?: Task[] }) => Project;
  updateProject: (id: string, updates: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  toggleTaskDone: (projectId: string, taskId: string) => void;
  addTask: (projectId: string, task: Omit<Task, 'id'>) => void;
  updateTask: (projectId: string, taskId: string, updates: Partial<Task>) => void;
  deleteTask: (projectId: string, taskId: string) => void;
  approveProject: (projectId: string, approvedBy?: string) => void;

  // Proofs & Client Portal
  addProof: (projectId: string, proofData: Omit<Proof, 'id' | 'uploadedAt' | 'version' | 'status'>) => void;
  updateProofStatus: (projectId: string, proofId: string, status: 'approved' | 'rejected' | 'pending') => void;
  addProofFeedback: (projectId: string, proofId: string, authorName: string, authorRole: 'studio' | 'client', message: string) => void;

  // Client Actions
  createClient: (client: Omit<Client, 'id' | 'createdAt' | 'portalToken'>) => Client;
  updateClient: (id: string, updates: Partial<Client>) => void;
  deleteClient: (id: string) => void;

  // Quote Actions
  createQuote: (quote: Omit<Quote, 'id' | 'created'>) => Quote;
  updateQuote: (id: string, updates: Partial<Quote>) => void;
  deleteQuote: (id: string) => void;

  // Price Catalog Actions
  createPriceCatalogItem: (item: Omit<PriceCatalogItem, 'id'>) => PriceCatalogItem;
  updatePriceCatalogItem: (id: string, updates: Partial<PriceCatalogItem>) => void;
  deletePriceCatalogItem: (id: string) => void;

  // Inventory Actions
  createInventoryItem: (item: Omit<InventoryItem, 'id'>) => InventoryItem;
  updateInventoryItem: (id: string, updates: Partial<InventoryItem>) => void;
  adjustStock: (id: string, delta: number) => void;
  deleteInventoryItem: (id: string) => void;

  // Financial Actions (Bilancio Studio & Spese/Entrate di Progetto)
  createFinancialRecord: (record: Omit<FinancialRecord, 'id' | 'createdAt'>) => FinancialRecord;
  updateFinancialRecord: (id: string, updates: Partial<FinancialRecord>) => void;
  deleteFinancialRecord: (id: string) => void;

  // Settings & DB Actions
  updateSettings: (updates: Partial<StudioSettings>) => void;
  connectSupabase: (url: string, key: string) => Promise<{ success: boolean; message: string }>;
  syncDatabase: () => Promise<void>;
  exportBackupJson: () => string;
  importBackupJson: (jsonStr: string) => boolean;
  resetStudioData: () => void;
}

const StudioContext = createContext<StudioContextType | undefined>(undefined);

export const StudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [projects, setProjects] = useState<Project[]>(DEFAULT_PROJECTS);
  const [clients, setClients] = useState<Client[]>(DEFAULT_CLIENTS);
  const [quotes, setQuotes] = useState<Quote[]>(DEFAULT_QUOTES);
  const [inventory, setInventory] = useState<InventoryItem[]>(DEFAULT_INVENTORY);
  const [priceCatalog, setPriceCatalog] = useState<PriceCatalogItem[]>(DEFAULT_PRICE_CATALOG);
  const [settings, setSettings] = useState<StudioSettings>(DEFAULT_SETTINGS);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>(DEFAULT_TEAM);
  const [financials, setFinancials] = useState<FinancialRecord[]>(DEFAULT_FINANCIAL_RECORDS);

  const [dbStatus, setDbStatus] = useState<'connected' | 'local_fallback' | 'error'>('connected');
  const [isSyncing, setIsSyncing] = useState<boolean>(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);

  // Keep a stable ref of the latest state to avoid infinite hook loops
  const stateRef = useRef({
    projects,
    clients,
    quotes,
    inventory,
    priceCatalog,
    settings,
    teamMembers,
    financials,
  });

  useEffect(() => {
    stateRef.current = {
      projects,
      clients,
      quotes,
      inventory,
      priceCatalog,
      settings,
      teamMembers,
      financials,
    };
  }, [projects, clients, quotes, inventory, priceCatalog, settings, teamMembers, financials]);

  // Apply incoming synchronized state from Firestore, BroadcastChannel, or Cloud
  const applyIncomingState = useCallback((parsed: any) => {
    if (!parsed) return;
    try {
      if (Array.isArray(parsed.projects)) setProjects(parsed.projects);
      if (Array.isArray(parsed.clients)) {
        const loadedClients = parsed.clients.map((c: Client) => ({
          ...c,
          portalPassword:
            c.portalPassword ||
            DEFAULT_CLIENTS.find((dc) => dc.id === c.id)?.portalPassword ||
            generatePortalPassword(c.name),
        }));
        setClients(loadedClients);
      }
      if (Array.isArray(parsed.quotes)) setQuotes(parsed.quotes);
      if (Array.isArray(parsed.inventory)) setInventory(parsed.inventory);
      if (Array.isArray(parsed.priceCatalog)) setPriceCatalog(parsed.priceCatalog);
      if (Array.isArray(parsed.financials)) setFinancials(parsed.financials);
      if (parsed.settings) setSettings(parsed.settings);
      if (Array.isArray(parsed.teamMembers)) setTeamMembers(parsed.teamMembers);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      setDbStatus('connected');
    } catch (err) {
      console.warn('Error applying incoming state:', err);
    }
  }, []);

  // Persist state updates to local cache and BroadcastChannel
  const persistLocalCache = useCallback(
    (
      newProjects?: Project[],
      newClients?: Client[],
      newQuotes?: Quote[],
      newInventory?: InventoryItem[],
      newPriceCatalog?: PriceCatalogItem[],
      newSettings?: StudioSettings,
      newTeam?: TeamMember[],
      newFinancials?: FinancialRecord[]
    ) => {
      const cur = stateRef.current;
      const payload = {
        projects: newProjects ?? cur.projects,
        clients: newClients ?? cur.clients,
        quotes: newQuotes ?? cur.quotes,
        inventory: newInventory ?? cur.inventory,
        priceCatalog: newPriceCatalog ?? cur.priceCatalog,
        settings: newSettings ?? cur.settings,
        teamMembers: newTeam ?? cur.teamMembers,
        financials: newFinancials ?? cur.financials,
        updatedAt: new Date().toISOString(),
      };

      try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
      } catch (e) {
        console.error('LocalStorage write error:', e);
      }

      // Broadcast to other open tabs in real time
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          const channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
          channel.postMessage({ type: 'STUDIO_SYNC', payload });
          channel.close();
        }
      } catch (bcErr) {
        console.warn('BroadcastChannel error:', bcErr);
      }

      // Background central server sync if running full-stack
      fetch('/api/studio/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});

      // Background Supabase sync if configured
      if (isSupabaseConfigured()) {
        saveRemoteStudioData(payload).catch(() => {});
      }
    },
    []
  );

  // ---------------------------------------------------------------------------
  // FIRESTORE REAL-TIME SYNCHRONIZATION LISTENERS
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setIsSyncing(true);

    // Track authentication state
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
    });

    // Check connection first
    testConnection().then((ok) => {
      if (ok) {
        setDbStatus('connected');
      }
    });

    // 1. Projects Real-Time Listener
    const unsubscribeProjects = onSnapshot(
      collection(db, 'projects'),
      (snapshot) => {
        if (!snapshot.empty) {
          const projs: Project[] = snapshot.docs.map((d) => d.data() as Project);
          setProjects(projs);
          setDbStatus('connected');
          setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
        } else {
          // If Firestore is empty on initial setup, seed default projects
          DEFAULT_PROJECTS.forEach((p) => {
            setDoc(doc(db, 'projects', p.id), p).catch((err) =>
              handleFirestoreError(err, OperationType.CREATE, `projects/${p.id}`)
            );
          });
        }
        setIsSyncing(false);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'projects');
        setIsSyncing(false);
      }
    );

    // 2. Clients Real-Time Listener
    const unsubscribeClients = onSnapshot(
      collection(db, 'clients'),
      (snapshot) => {
        if (!snapshot.empty) {
          const cls: Client[] = snapshot.docs.map((d) => {
            const data = d.data() as Client;
            return {
              ...data,
              portalPassword:
                data.portalPassword ||
                DEFAULT_CLIENTS.find((dc) => dc.id === data.id)?.portalPassword ||
                generatePortalPassword(data.name),
            };
          });
          setClients(cls);
        } else {
          DEFAULT_CLIENTS.forEach((c) => {
            setDoc(doc(db, 'clients', c.id), c).catch((err) =>
              handleFirestoreError(err, OperationType.CREATE, `clients/${c.id}`)
            );
          });
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'clients');
      }
    );

    // 3. Quotes Real-Time Listener
    const unsubscribeQuotes = onSnapshot(
      collection(db, 'quotes'),
      (snapshot) => {
        if (!snapshot.empty) {
          const qts: Quote[] = snapshot.docs.map((d) => d.data() as Quote);
          setQuotes(qts);
        } else {
          DEFAULT_QUOTES.forEach((q) => {
            setDoc(doc(db, 'quotes', q.id), q).catch((err) =>
              handleFirestoreError(err, OperationType.CREATE, `quotes/${q.id}`)
            );
          });
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'quotes');
      }
    );

    // 4. Inventory Real-Time Listener
    const unsubscribeInventory = onSnapshot(
      collection(db, 'inventory'),
      (snapshot) => {
        if (!snapshot.empty) {
          const inv: InventoryItem[] = snapshot.docs.map((d) => d.data() as InventoryItem);
          setInventory(inv);
        } else {
          DEFAULT_INVENTORY.forEach((item) => {
            setDoc(doc(db, 'inventory', item.id), item).catch((err) =>
              handleFirestoreError(err, OperationType.CREATE, `inventory/${item.id}`)
            );
          });
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'inventory');
      }
    );

    // 5. Price Catalog Real-Time Listener
    const unsubscribePriceCatalog = onSnapshot(
      collection(db, 'price_catalog'),
      (snapshot) => {
        if (!snapshot.empty) {
          const pc: PriceCatalogItem[] = snapshot.docs.map((d) => d.data() as PriceCatalogItem);
          setPriceCatalog(pc);
        } else {
          DEFAULT_PRICE_CATALOG.forEach((item) => {
            setDoc(doc(db, 'price_catalog', item.id), item).catch((err) =>
              handleFirestoreError(err, OperationType.CREATE, `price_catalog/${item.id}`)
            );
          });
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'price_catalog');
      }
    );

    // 6. Financial Records Real-Time Listener
    const unsubscribeFinancials = onSnapshot(
      collection(db, 'financials'),
      (snapshot) => {
        if (!snapshot.empty) {
          const fins: FinancialRecord[] = snapshot.docs.map((d) => d.data() as FinancialRecord);
          setFinancials(fins);
        } else {
          DEFAULT_FINANCIAL_RECORDS.forEach((item) => {
            setDoc(doc(db, 'financials', item.id), item).catch((err) =>
              handleFirestoreError(err, OperationType.CREATE, `financials/${item.id}`)
            );
          });
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'financials');
      }
    );

    // 7. Settings Real-Time Listener
    const unsubscribeSettings = onSnapshot(
      doc(db, 'settings', 'studio_settings'),
      (docSnap) => {
        if (docSnap.exists()) {
          setSettings(docSnap.data() as StudioSettings);
        } else {
          setDoc(doc(db, 'settings', 'studio_settings'), DEFAULT_SETTINGS).catch((err) =>
            handleFirestoreError(err, OperationType.CREATE, 'settings/studio_settings')
          );
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'settings/studio_settings');
      }
    );

    // Load local storage fallback immediately if offline
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && Array.isArray(parsed.projects)) {
          applyIncomingState(parsed);
        }
      }
    } catch (e) {
      console.warn('Local storage fallback error:', e);
    }

    return () => {
      unsubscribeAuth();
      unsubscribeProjects();
      unsubscribeClients();
      unsubscribeQuotes();
      unsubscribeInventory();
      unsubscribePriceCatalog();
      unsubscribeFinancials();
      unsubscribeSettings();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Multi-tab BroadcastChannel and cross-window listener
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
        channel.onmessage = (event) => {
          if (event.data?.type === 'STUDIO_SYNC' && event.data?.payload) {
            applyIncomingState(event.data.payload);
          }
        };
      }
    } catch (e) {
      console.warn('Could not initialize BroadcastChannel listener:', e);
    }

    const handleStorageEvent = (e: StorageEvent) => {
      if (e.key === LOCAL_STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          applyIncomingState(parsed);
        } catch (err) {
          console.warn('Storage event parse error:', err);
        }
      }
    };

    window.addEventListener('storage', handleStorageEvent);

    return () => {
      if (channel) channel.close();
      window.removeEventListener('storage', handleStorageEvent);
    };
  }, [applyIncomingState]);

  // Compute backward plans automatically
  const plannerResult = useMemo(() => {
    return computeBackwardPlans(projects, settings);
  }, [projects, settings]);

  // ---------------------------------------------------------------------------
  // PROJECT ACTIONS (WRITES TO CLOUD FIRESTORE)
  // ---------------------------------------------------------------------------
  const createProject = useCallback(
    (data: Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'tasks'> & { tasks?: Task[] }): Project => {
      const newTasks = data.tasks && data.tasks.length > 0 ? data.tasks : buildDefaultTasks(data.type, data.owner);
      const newProj: Project = {
        ...data,
        id: 'p_' + generateId(),
        tasks: newTasks,
        proofs: [],
        createdAt: TODAY_ISO(),
        updatedAt: TODAY_ISO(),
      };

      setProjects((prev) => [newProj, ...prev.filter((p) => p.id !== newProj.id)]);
      persistLocalCache([newProj, ...projects]);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      // Write directly to Cloud Firestore
      setDoc(doc(db, 'projects', newProj.id), newProj).catch((err) =>
        handleFirestoreError(err, OperationType.CREATE, `projects/${newProj.id}`)
      );

      return newProj;
    },
    [projects, persistLocalCache]
  );

  const updateProject = useCallback(
    (id: string, updates: Partial<Project>) => {
      let updatedProject: Project | null = null;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          updatedProject = { ...p, ...updates, updatedAt: TODAY_ISO() };
          return updatedProject;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedProject) {
        setDoc(doc(db, 'projects', id), updatedProject, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `projects/${id}`)
        );
      }
    },
    []
  );

  const deleteProject = useCallback((id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    deleteDoc(doc(db, 'projects', id)).catch((err) =>
      handleFirestoreError(err, OperationType.DELETE, `projects/${id}`)
    );
  }, []);

  const toggleTaskDone = useCallback(
    (projectId: string, taskId: string) => {
      let updatedProject: Project | null = null;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          const newTasks = p.tasks.map((t) => {
            if (t.id !== taskId) return t;
            const nextDone = !t.done;
            return {
              ...t,
              done: nextDone,
              doneAt: nextDone ? TODAY_ISO() : undefined,
            };
          });
          updatedProject = { ...p, tasks: newTasks, updatedAt: TODAY_ISO() };
          return updatedProject;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedProject) {
        setDoc(doc(db, 'projects', projectId), updatedProject, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `projects/${projectId}`)
        );
      }
    },
    []
  );

  const addTask = useCallback(
    (projectId: string, task: Omit<Task, 'id'>) => {
      const newTask: Task = { ...task, id: 't_' + generateId() };
      let updatedProject: Project | null = null;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          updatedProject = { ...p, tasks: [...p.tasks, newTask], updatedAt: TODAY_ISO() };
          return updatedProject;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedProject) {
        setDoc(doc(db, 'projects', projectId), updatedProject, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `projects/${projectId}`)
        );
      }
    },
    []
  );

  const updateTask = useCallback(
    (projectId: string, taskId: string, taskUpdates: Partial<Task>) => {
      let updatedProject: Project | null = null;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          const newTasks = p.tasks.map((t) => (t.id === taskId ? { ...t, ...taskUpdates } : t));
          updatedProject = { ...p, tasks: newTasks, updatedAt: TODAY_ISO() };
          return updatedProject;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedProject) {
        setDoc(doc(db, 'projects', projectId), updatedProject, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `projects/${projectId}`)
        );
      }
    },
    []
  );

  const deleteTask = useCallback(
    (projectId: string, taskId: string) => {
      let updatedProject: Project | null = null;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          updatedProject = {
            ...p,
            tasks: p.tasks.filter((t) => t.id !== taskId),
            updatedAt: TODAY_ISO(),
          };
          return updatedProject;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedProject) {
        setDoc(doc(db, 'projects', projectId), updatedProject, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `projects/${projectId}`)
        );
      }
    },
    []
  );

  const approveProject = useCallback(
    (projectId: string, approvedBy: string = 'Cliente (da Portale)') => {
      let updatedProject: Project | null = null;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          const newTasks = p.tasks.map((t) => {
            if (t.name.toLowerCase().includes('approvazione') || t.name.toLowerCase().includes('bozza')) {
              return { ...t, done: true, doneAt: TODAY_ISO() };
            }
            return t;
          });
          updatedProject = {
            ...p,
            approved: true,
            approvedAt: new Date().toISOString(),
            approvedBy,
            status: 'production',
            tasks: newTasks,
            updatedAt: TODAY_ISO(),
          };
          return updatedProject;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedProject) {
        setDoc(doc(db, 'projects', projectId), updatedProject, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `projects/${projectId}`)
        );
      }
    },
    []
  );

  const addProof = useCallback(
    (projectId: string, proofData: Omit<Proof, 'id' | 'uploadedAt' | 'version' | 'status'>) => {
      let updatedProject: Project | null = null;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          const currentVersion = p.proofs ? p.proofs.length + 1 : 1;
          const newProof: Proof = {
            ...proofData,
            id: 'prf_' + generateId(),
            version: currentVersion,
            status: 'pending',
            uploadedAt: TODAY_ISO(),
            feedback: [],
          };
          updatedProject = {
            ...p,
            status: 'review',
            proofs: [newProof, ...(p.proofs || [])],
            updatedAt: TODAY_ISO(),
          };
          return updatedProject;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedProject) {
        setDoc(doc(db, 'projects', projectId), updatedProject, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `projects/${projectId}`)
        );
      }
    },
    []
  );

  const updateProofStatus = useCallback(
    (projectId: string, proofId: string, status: 'approved' | 'rejected' | 'pending') => {
      let updatedProject: Project | null = null;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          const newProofs = (p.proofs || []).map((prf) => (prf.id === proofId ? { ...prf, status } : prf));
          updatedProject = {
            ...p,
            proofs: newProofs,
            approved: status === 'approved',
            approvedAt: status === 'approved' ? new Date().toISOString() : p.approvedAt,
            status: status === 'approved' ? 'production' : p.status,
            updatedAt: TODAY_ISO(),
          };
          return updatedProject;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedProject) {
        setDoc(doc(db, 'projects', projectId), updatedProject, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `projects/${projectId}`)
        );
      }
    },
    []
  );

  const addProofFeedback = useCallback(
    (
      projectId: string,
      proofId: string,
      authorName: string,
      authorRole: 'studio' | 'client',
      message: string
    ) => {
      let updatedProject: Project | null = null;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          const newProofs = (p.proofs || []).map((prf) => {
            if (prf.id !== proofId) return prf;
            const newFeedback: ProofFeedback = {
              id: 'fb_' + generateId(),
              projectId,
              authorName,
              authorRole,
              message,
              createdAt: new Date().toISOString(),
            };
            return {
              ...prf,
              feedback: [...(prf.feedback || []), newFeedback],
            };
          });
          updatedProject = { ...p, proofs: newProofs, updatedAt: TODAY_ISO() };
          return updatedProject;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedProject) {
        setDoc(doc(db, 'projects', projectId), updatedProject, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `projects/${projectId}`)
        );
      }
    },
    []
  );

  // ---------------------------------------------------------------------------
  // CLIENT ACTIONS (WRITES TO CLOUD FIRESTORE)
  // ---------------------------------------------------------------------------
  const createClient = useCallback(
    (clientData: Omit<Client, 'id' | 'createdAt' | 'portalToken'>): Client => {
      const newClient: Client = {
        ...clientData,
        id: 'c_' + generateId(),
        portalToken: 'pt_' + generateId(),
        portalPassword: clientData.portalPassword || generatePortalPassword(clientData.name),
        portalEnabled: true,
        createdAt: TODAY_ISO(),
      };
      setClients((prev) => [newClient, ...prev]);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      setDoc(doc(db, 'clients', newClient.id), newClient).catch((err) =>
        handleFirestoreError(err, OperationType.CREATE, `clients/${newClient.id}`)
      );

      return newClient;
    },
    []
  );

  const updateClient = useCallback(
    (id: string, updates: Partial<Client>) => {
      let updatedClient: Client | null = null;
      setClients((prev) =>
        prev.map((c) => {
          if (c.id !== id) return c;
          updatedClient = { ...c, ...updates };
          return updatedClient;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedClient) {
        setDoc(doc(db, 'clients', id), updatedClient, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `clients/${id}`)
        );
      }
    },
    []
  );

  const deleteClient = useCallback((id: string) => {
    setClients((prev) => prev.filter((c) => c.id !== id));
    setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    deleteDoc(doc(db, 'clients', id)).catch((err) =>
      handleFirestoreError(err, OperationType.DELETE, `clients/${id}`)
    );
  }, []);

  // ---------------------------------------------------------------------------
  // QUOTE ACTIONS (WRITES TO CLOUD FIRESTORE)
  // ---------------------------------------------------------------------------
  const createQuote = useCallback(
    (quoteData: Omit<Quote, 'id' | 'created'>): Quote => {
      const newQuote: Quote = {
        ...quoteData,
        id: 'q_' + generateId(),
        created: TODAY_ISO(),
      };
      setQuotes((prev) => [newQuote, ...prev]);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      setDoc(doc(db, 'quotes', newQuote.id), newQuote).catch((err) =>
        handleFirestoreError(err, OperationType.CREATE, `quotes/${newQuote.id}`)
      );

      return newQuote;
    },
    []
  );

  const updateQuote = useCallback(
    (id: string, updates: Partial<Quote>) => {
      let updatedQuote: Quote | null = null;
      setQuotes((prev) =>
        prev.map((q) => {
          if (q.id !== id) return q;
          updatedQuote = { ...q, ...updates };
          return updatedQuote;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedQuote) {
        setDoc(doc(db, 'quotes', id), updatedQuote, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `quotes/${id}`)
        );
      }
    },
    []
  );

  const deleteQuote = useCallback((id: string) => {
    setQuotes((prev) => prev.filter((q) => q.id !== id));
    setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    deleteDoc(doc(db, 'quotes', id)).catch((err) =>
      handleFirestoreError(err, OperationType.DELETE, `quotes/${id}`)
    );
  }, []);

  // ---------------------------------------------------------------------------
  // PRICE CATALOG ACTIONS (WRITES TO CLOUD FIRESTORE)
  // ---------------------------------------------------------------------------
  const createPriceCatalogItem = useCallback(
    (itemData: Omit<PriceCatalogItem, 'id'>): PriceCatalogItem => {
      const newItem: PriceCatalogItem = {
        ...itemData,
        id: 'pc_' + generateId(),
      };
      setPriceCatalog((prev) => [...prev, newItem]);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      setDoc(doc(db, 'price_catalog', newItem.id), newItem).catch((err) =>
        handleFirestoreError(err, OperationType.CREATE, `price_catalog/${newItem.id}`)
      );

      return newItem;
    },
    []
  );

  const updatePriceCatalogItem = useCallback(
    (id: string, updates: Partial<PriceCatalogItem>) => {
      let updatedItem: PriceCatalogItem | null = null;
      setPriceCatalog((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          updatedItem = { ...item, ...updates };
          return updatedItem;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedItem) {
        setDoc(doc(db, 'price_catalog', id), updatedItem, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `price_catalog/${id}`)
        );
      }
    },
    []
  );

  const deletePriceCatalogItem = useCallback((id: string) => {
    setPriceCatalog((prev) => prev.filter((item) => item.id !== id));
    setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    deleteDoc(doc(db, 'price_catalog', id)).catch((err) =>
      handleFirestoreError(err, OperationType.DELETE, `price_catalog/${id}`)
    );
  }, []);

  // ---------------------------------------------------------------------------
  // INVENTORY ACTIONS (WRITES TO CLOUD FIRESTORE)
  // ---------------------------------------------------------------------------
  const createInventoryItem = useCallback(
    (itemData: Omit<InventoryItem, 'id'>): InventoryItem => {
      const newItem: InventoryItem = {
        ...itemData,
        id: 'inv_' + generateId(),
      };
      setInventory((prev) => [...prev, newItem]);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      setDoc(doc(db, 'inventory', newItem.id), newItem).catch((err) =>
        handleFirestoreError(err, OperationType.CREATE, `inventory/${newItem.id}`)
      );

      return newItem;
    },
    []
  );

  const updateInventoryItem = useCallback(
    (id: string, updates: Partial<InventoryItem>) => {
      let updatedItem: InventoryItem | null = null;
      setInventory((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          updatedItem = { ...item, ...updates };
          return updatedItem;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedItem) {
        setDoc(doc(db, 'inventory', id), updatedItem, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `inventory/${id}`)
        );
      }
    },
    []
  );

  const adjustStock = useCallback(
    (id: string, delta: number) => {
      let updatedItem: InventoryItem | null = null;
      setInventory((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          const newQty = Math.max(0, (item.qty || 0) + delta);
          updatedItem = { ...item, qty: newQty };
          return updatedItem;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedItem) {
        setDoc(doc(db, 'inventory', id), updatedItem, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `inventory/${id}`)
        );
      }
    },
    []
  );

  const deleteInventoryItem = useCallback((id: string) => {
    setInventory((prev) => prev.filter((item) => item.id !== id));
    setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    deleteDoc(doc(db, 'inventory', id)).catch((err) =>
      handleFirestoreError(err, OperationType.DELETE, `inventory/${id}`)
    );
  }, []);

  // ---------------------------------------------------------------------------
  // FINANCIAL ACTIONS (WRITES TO CLOUD FIRESTORE)
  // ---------------------------------------------------------------------------
  const createFinancialRecord = useCallback(
    (recordData: Omit<FinancialRecord, 'id' | 'createdAt'>): FinancialRecord => {
      const newRec: FinancialRecord = {
        ...recordData,
        id: 'fin_' + generateId(),
        createdAt: TODAY_ISO(),
      };
      setFinancials((prev) => [newRec, ...prev]);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      setDoc(doc(db, 'financials', newRec.id), newRec).catch((err) =>
        handleFirestoreError(err, OperationType.CREATE, `financials/${newRec.id}`)
      );

      return newRec;
    },
    []
  );

  const updateFinancialRecord = useCallback(
    (id: string, updates: Partial<FinancialRecord>) => {
      let updatedRec: FinancialRecord | null = null;
      setFinancials((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          updatedRec = { ...r, ...updates };
          return updatedRec;
        })
      );
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));

      if (updatedRec) {
        setDoc(doc(db, 'financials', id), updatedRec, { merge: true }).catch((err) =>
          handleFirestoreError(err, OperationType.UPDATE, `financials/${id}`)
        );
      }
    },
    []
  );

  const deleteFinancialRecord = useCallback((id: string) => {
    setFinancials((prev) => prev.filter((r) => r.id !== id));
    setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    deleteDoc(doc(db, 'financials', id)).catch((err) =>
      handleFirestoreError(err, OperationType.DELETE, `financials/${id}`)
    );
  }, []);

  // ---------------------------------------------------------------------------
  // SETTINGS & CLOUD SYNC ACTIONS
  // ---------------------------------------------------------------------------
  const updateSettings = useCallback(
    (updates: Partial<StudioSettings>) => {
      const updated = { ...settings, ...updates };
      setSettings(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      setDoc(doc(db, 'settings', 'studio_settings'), updated, { merge: true }).catch((err) =>
        handleFirestoreError(err, OperationType.UPDATE, 'settings/studio_settings')
      );
    },
    [settings]
  );

  const connectSupabase = useCallback(
    async (url: string, key: string) => {
      try {
        const client = initSupabase(url, key);
        if (!client) {
          return { success: false, message: 'URL o Anon Key di Supabase non validi.' };
        }
        const payload = {
          projects,
          clients,
          quotes,
          inventory,
          priceCatalog,
          settings,
          teamMembers,
          financials,
          updatedAt: new Date().toISOString(),
        };
        const ok = await saveRemoteStudioData(payload);
        if (ok) {
          setDbStatus('connected');
          setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
          return { success: true, message: 'Database Supabase collegato e sincronizzato in Cloud!' };
        } else {
          return { success: true, message: 'Connessione Supabase stabilita. Verifica che la tabella studio_state esista.' };
        }
      } catch (err: any) {
        return { success: false, message: `Errore: ${err.message || 'Verifica credenziali'}` };
      }
    },
    [projects, clients, quotes, inventory, priceCatalog, settings, teamMembers, financials]
  );

  const syncDatabase = useCallback(async () => {
    setIsSyncing(true);
    try {
      // 1. Fetch from Firestore projects
      const snap = await getDocs(collection(db, 'projects'));
      if (!snap.empty) {
        const projs = snap.docs.map((d) => d.data() as Project);
        setProjects(projs);
        setDbStatus('connected');
        setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.GET, 'projects');
    } finally {
      setIsSyncing(false);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    }
  }, []);

  const exportBackupJson = useCallback((): string => {
    return JSON.stringify(
      {
        version: 2,
        brand: 'Sage Paper Design',
        exportedAt: new Date().toISOString(),
        settings,
        teamMembers,
        clients,
        projects,
        quotes,
        inventory,
        priceCatalog,
        financials,
      },
      null,
      2
    );
  }, [settings, teamMembers, clients, projects, quotes, inventory, priceCatalog, financials]);

  const importBackupJson = useCallback(
    (jsonStr: string): boolean => {
      try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed || !Array.isArray(parsed.projects) || !Array.isArray(parsed.clients)) {
          return false;
        }
        applyIncomingState(parsed);
        // Save imported items directly to Firestore
        parsed.projects.forEach((p: Project) => {
          setDoc(doc(db, 'projects', p.id), p).catch(() => {});
        });
        parsed.clients.forEach((c: Client) => {
          setDoc(doc(db, 'clients', c.id), c).catch(() => {});
        });
        if (Array.isArray(parsed.quotes)) {
          parsed.quotes.forEach((q: Quote) => {
            setDoc(doc(db, 'quotes', q.id), q).catch(() => {});
          });
        }
        if (Array.isArray(parsed.inventory)) {
          parsed.inventory.forEach((inv: InventoryItem) => {
            setDoc(doc(db, 'inventory', inv.id), inv).catch(() => {});
          });
        }
        return true;
      } catch {
        return false;
      }
    },
    [applyIncomingState]
  );

  const resetStudioData = useCallback(() => {
    setProjects(DEFAULT_PROJECTS);
    setClients(DEFAULT_CLIENTS);
    setQuotes(DEFAULT_QUOTES);
    setInventory(DEFAULT_INVENTORY);
    setPriceCatalog(DEFAULT_PRICE_CATALOG);
    setFinancials(DEFAULT_FINANCIAL_RECORDS);
    setSettings(DEFAULT_SETTINGS);
    setTeamMembers(DEFAULT_TEAM);

    DEFAULT_PROJECTS.forEach((p) => setDoc(doc(db, 'projects', p.id), p).catch(() => {}));
    DEFAULT_CLIENTS.forEach((c) => setDoc(doc(db, 'clients', c.id), c).catch(() => {}));
    DEFAULT_QUOTES.forEach((q) => setDoc(doc(db, 'quotes', q.id), q).catch(() => {}));
    DEFAULT_INVENTORY.forEach((inv) => setDoc(doc(db, 'inventory', inv.id), inv).catch(() => {}));
    DEFAULT_PRICE_CATALOG.forEach((item) => setDoc(doc(db, 'price_catalog', item.id), item).catch(() => {}));
    DEFAULT_FINANCIAL_RECORDS.forEach((fin) => setDoc(doc(db, 'financials', fin.id), fin).catch(() => {}));
    setDoc(doc(db, 'settings', 'studio_settings'), DEFAULT_SETTINGS).catch(() => {});

    setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
  }, []);

  return (
    <StudioContext.Provider
      value={{
        projects,
        clients,
        quotes,
        inventory,
        priceCatalog,
        financials,
        settings,
        teamMembers,
        plannerResult,
        dbStatus,
        isSyncing,
        lastSyncedAt,
        currentUser,
        loginWithGoogle,
        logoutUser,
        firebaseConfig,
        createProject,
        updateProject,
        deleteProject,
        toggleTaskDone,
        addTask,
        updateTask,
        deleteTask,
        approveProject,
        addProof,
        updateProofStatus,
        addProofFeedback,
        createClient,
        updateClient,
        deleteClient,
        createQuote,
        updateQuote,
        deleteQuote,
        createPriceCatalogItem,
        updatePriceCatalogItem,
        deletePriceCatalogItem,
        createInventoryItem,
        updateInventoryItem,
        adjustStock,
        deleteInventoryItem,
        createFinancialRecord,
        updateFinancialRecord,
        deleteFinancialRecord,
        updateSettings,
        connectSupabase,
        syncDatabase,
        exportBackupJson,
        importBackupJson,
        resetStudioData,
      }}
    >
      {children}
    </StudioContext.Provider>
  );
};

export const useStudio = () => {
  const context = useContext(StudioContext);
  if (!context) {
    throw new Error('useStudio must be used within a StudioProvider');
  }
  return context;
};
