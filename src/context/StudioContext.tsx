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
import { testConnection } from '../lib/firebase';
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
    id: 'giulia',
    name: 'Giulia',
    role: 'Titolare & Creative Director',
    weeklyHours: 30,
    color: '#244d3b',
    avatar: 'G',
    active: true,
  },
  {
    id: 'claudia',
    name: 'Claudia',
    role: 'Responsabile Produzione & Taglio',
    weeklyHours: 4,
    color: '#628391',
    avatar: 'C',
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

  // Apply incoming synchronized state from another tab/window or cloud
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

  // Persist state updates to local storage, broadcast in real-time, and sync to cloud
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

      // 1. Broadcast to all other open tabs/windows in real time
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          const channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
          channel.postMessage({ type: 'STUDIO_SYNC', payload });
          channel.close();
        }
      } catch (bcErr) {
        console.warn('BroadcastChannel error:', bcErr);
      }

      // 2. Cloud Remote Sync if Supabase is configured
      if (isSupabaseConfigured()) {
        saveRemoteStudioData(payload).catch((err) => {
          console.warn('Background Supabase save warning:', err);
        });
      }
    },
    []
  );

  // Load from local persistent storage or default data on mount & connect to remote cloud
  useEffect(() => {
    async function loadData() {
      setIsSyncing(true);
      try {
        // 1. Check if remote cloud data is available first
        if (isSupabaseConfigured()) {
          const remoteData = await fetchRemoteStudioData();
          if (remoteData && Array.isArray(remoteData.projects)) {
            applyIncomingState(remoteData);
            setIsSyncing(false);
            return;
          }
        }

        // 2. Load from local persistent storage
        const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && Array.isArray(parsed.projects) && parsed.projects.length > 0) {
            applyIncomingState(parsed);
          } else {
            // First time seeding
            setProjects(DEFAULT_PROJECTS);
            setClients(DEFAULT_CLIENTS);
            setQuotes(DEFAULT_QUOTES);
            setInventory(DEFAULT_INVENTORY);
            setPriceCatalog(DEFAULT_PRICE_CATALOG);
            setFinancials(DEFAULT_FINANCIAL_RECORDS);
            persistLocalCache(
              DEFAULT_PROJECTS,
              DEFAULT_CLIENTS,
              DEFAULT_QUOTES,
              DEFAULT_INVENTORY,
              DEFAULT_PRICE_CATALOG,
              DEFAULT_SETTINGS,
              DEFAULT_TEAM,
              DEFAULT_FINANCIAL_RECORDS
            );
          }
        } else {
          // Initialize default data
          persistLocalCache(
            DEFAULT_PROJECTS,
            DEFAULT_CLIENTS,
            DEFAULT_QUOTES,
            DEFAULT_INVENTORY,
            DEFAULT_PRICE_CATALOG,
            DEFAULT_SETTINGS,
            DEFAULT_TEAM,
            DEFAULT_FINANCIAL_RECORDS
          );
        }
      } catch (e) {
        console.warn('LocalStorage read warning:', e);
      }

      // Check Firestore connectivity in background
      testConnection().then((ok) => {
        if (ok) {
          setDbStatus('connected');
        } else {
          setDbStatus('connected'); // Local persistent store active
        }
      });

      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      setIsSyncing(false);
    }

    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real-time synchronization listener across tabs & windows
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

  // Project Actions
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

      const updated = [newProj, ...projects];
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      return newProj;
    },
    [projects, persistLocalCache]
  );

  const updateProject = useCallback(
    (id: string, updates: Partial<Project>) => {
      const updated = projects.map((p) => {
        if (p.id !== id) return p;
        return {
          ...p,
          ...updates,
          updatedAt: TODAY_ISO(),
        };
      });
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  const deleteProject = useCallback(
    (id: string) => {
      const updated = projects.filter((p) => p.id !== id);
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  const toggleTaskDone = useCallback(
    (projectId: string, taskId: string) => {
      const updated = projects.map((p) => {
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
        return { ...p, tasks: newTasks, updatedAt: TODAY_ISO() };
      });
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  const addTask = useCallback(
    (projectId: string, task: Omit<Task, 'id'>) => {
      const newTask: Task = { ...task, id: 't_' + generateId() };
      const updated = projects.map((p) => {
        if (p.id !== projectId) return p;
        return { ...p, tasks: [...p.tasks, newTask], updatedAt: TODAY_ISO() };
      });
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  const updateTask = useCallback(
    (projectId: string, taskId: string, taskUpdates: Partial<Task>) => {
      const updated = projects.map((p) => {
        if (p.id !== projectId) return p;
        const newTasks = p.tasks.map((t) => (t.id === taskId ? { ...t, ...taskUpdates } : t));
        return { ...p, tasks: newTasks, updatedAt: TODAY_ISO() };
      });
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  const deleteTask = useCallback(
    (projectId: string, taskId: string) => {
      const updated = projects.map((p) => {
        if (p.id !== projectId) return p;
        return { ...p, tasks: p.tasks.filter((t) => t.id !== taskId), updatedAt: TODAY_ISO() };
      });
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  const approveProject = useCallback(
    (projectId: string, approvedBy?: string) => {
      const updated = projects.map((p) => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          approved: true,
          approvedAt: TODAY_ISO(),
          approvedBy: approvedBy || 'Cliente Verificato',
          updatedAt: TODAY_ISO(),
        };
      });
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  // Proofs & Client Portal
  const addProof = useCallback(
    (projectId: string, proofData: Omit<Proof, 'id' | 'uploadedAt' | 'version' | 'status'>) => {
      const newProof: Proof = {
        ...proofData,
        id: 'prf_' + generateId(),
        projectId,
        version: (projects.find((p) => p.id === projectId)?.proofs?.length || 0) + 1,
        status: 'pending',
        uploadedAt: TODAY_ISO(),
        feedback: [],
      };
      const updated = projects.map((p) => {
        if (p.id !== projectId) return p;
        const currentProofs = p.proofs || [];
        return {
          ...p,
          proofs: [newProof, ...currentProofs],
          status: p.status === 'new' ? 'review' : p.status,
          updatedAt: TODAY_ISO(),
        };
      });
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  const updateProofStatus = useCallback(
    (projectId: string, proofId: string, status: 'approved' | 'rejected' | 'pending') => {
      const updated = projects.map((p) => {
        if (p.id !== projectId) return p;
        const proofs = (p.proofs || []).map((prf) => (prf.id === proofId ? { ...prf, status } : prf));
        const allApproved = status === 'approved';
        return {
          ...p,
          proofs,
          approved: allApproved ? true : p.approved,
          approvedAt: allApproved ? TODAY_ISO() : p.approvedAt,
          updatedAt: TODAY_ISO(),
        };
      });
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  const addProofFeedback = useCallback(
    (
      projectId: string,
      proofId: string,
      authorName: string,
      authorRole: 'studio' | 'client',
      message: string
    ) => {
      const newFeedback: ProofFeedback = {
        id: 'fb_' + generateId(),
        projectId,
        proofId,
        authorName,
        authorRole,
        message,
        createdAt: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) + ' · ' + TODAY_ISO(),
      };
      const updated = projects.map((p) => {
        if (p.id !== projectId) return p;
        const proofs = (p.proofs || []).map((prf) => {
          if (prf.id !== proofId) return prf;
          return {
            ...prf,
            feedback: [...(prf.feedback || []), newFeedback],
          };
        });
        return { ...p, proofs, updatedAt: TODAY_ISO() };
      });
      setProjects(updated);
      persistLocalCache(updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [projects, persistLocalCache]
  );

  // Client Actions
  const createClient = useCallback(
    (clientData: Omit<Client, 'id' | 'createdAt' | 'portalToken'>): Client => {
      const newClient: Client = {
        ...clientData,
        id: 'c_' + generateId(),
        portalToken: 'portal_' + generateId(),
        portalPassword: clientData.portalPassword || generatePortalPassword(clientData.name),
        portalEnabled: true,
        createdAt: TODAY_ISO(),
      };
      const updated = [newClient, ...clients];
      setClients(updated);
      persistLocalCache(undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      return newClient;
    },
    [clients, persistLocalCache]
  );

  const updateClient = useCallback(
    (id: string, updates: Partial<Client>) => {
      const updated = clients.map((c) => (c.id === id ? { ...c, ...updates } : c));
      setClients(updated);
      persistLocalCache(undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [clients, persistLocalCache]
  );

  const deleteClient = useCallback(
    (id: string) => {
      const updated = clients.filter((c) => c.id !== id);
      setClients(updated);
      persistLocalCache(undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [clients, persistLocalCache]
  );

  // Quote Actions
  const createQuote = useCallback(
    (quoteData: Omit<Quote, 'id' | 'created'>): Quote => {
      const newQuote: Quote = {
        ...quoteData,
        id: 'q_' + generateId(),
        created: TODAY_ISO(),
      };
      const updated = [newQuote, ...quotes];
      setQuotes(updated);
      persistLocalCache(undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      return newQuote;
    },
    [quotes, persistLocalCache]
  );

  const updateQuote = useCallback(
    (id: string, updates: Partial<Quote>) => {
      const updated = quotes.map((q) => (q.id === id ? { ...q, ...updates } : q));
      setQuotes(updated);
      persistLocalCache(undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [quotes, persistLocalCache]
  );

  const deleteQuote = useCallback(
    (id: string) => {
      const updated = quotes.filter((q) => q.id !== id);
      setQuotes(updated);
      persistLocalCache(undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [quotes, persistLocalCache]
  );

  // Inventory Actions
  const createInventoryItem = useCallback(
    (itemData: Omit<InventoryItem, 'id'>): InventoryItem => {
      const newItem: InventoryItem = {
        ...itemData,
        id: 'm_' + generateId(),
      };
      const updated = [newItem, ...inventory];
      setInventory(updated);
      persistLocalCache(undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      return newItem;
    },
    [inventory, persistLocalCache]
  );

  const updateInventoryItem = useCallback(
    (id: string, updates: Partial<InventoryItem>) => {
      const updated = inventory.map((i) => (i.id === id ? { ...i, ...updates } : i));
      setInventory(updated);
      persistLocalCache(undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [inventory, persistLocalCache]
  );

  const adjustStock = useCallback(
    (id: string, delta: number) => {
      const updated = inventory.map((i) => {
        if (i.id !== id) return i;
        const newQty = Math.max(0, Number(i.qty) + delta);
        return { ...i, qty: newQty };
      });
      setInventory(updated);
      persistLocalCache(undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [inventory, persistLocalCache]
  );

  const deleteInventoryItem = useCallback(
    (id: string) => {
      const updated = inventory.filter((i) => i.id !== id);
      setInventory(updated);
      persistLocalCache(undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [inventory, persistLocalCache]
  );

  // Price Catalog Actions
  const createPriceCatalogItem = useCallback(
    (itemData: Omit<PriceCatalogItem, 'id'>): PriceCatalogItem => {
      const newItem: PriceCatalogItem = {
        ...itemData,
        id: 'cat_' + generateId(),
      };
      const updated = [...priceCatalog, newItem];
      setPriceCatalog(updated);
      persistLocalCache(undefined, undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      return newItem;
    },
    [priceCatalog, persistLocalCache]
  );

  const updatePriceCatalogItem = useCallback(
    (id: string, updates: Partial<PriceCatalogItem>) => {
      const updated = priceCatalog.map((item) => (item.id === id ? { ...item, ...updates } : item));
      setPriceCatalog(updated);
      persistLocalCache(undefined, undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [priceCatalog, persistLocalCache]
  );

  const deletePriceCatalogItem = useCallback(
    (id: string) => {
      const updated = priceCatalog.filter((item) => item.id !== id);
      setPriceCatalog(updated);
      persistLocalCache(undefined, undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [priceCatalog, persistLocalCache]
  );

  // Financial Actions (Bilancio Studio & Spese/Entrate di Progetto)
  const createFinancialRecord = useCallback(
    (recordData: Omit<FinancialRecord, 'id' | 'createdAt'>): FinancialRecord => {
      const newRecord: FinancialRecord = {
        ...recordData,
        id: 'fin_' + generateId(),
        createdAt: TODAY_ISO(),
      };
      const updated = [newRecord, ...financials];
      setFinancials(updated);
      persistLocalCache(undefined, undefined, undefined, undefined, undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
      return newRecord;
    },
    [financials, persistLocalCache]
  );

  const updateFinancialRecord = useCallback(
    (id: string, updates: Partial<FinancialRecord>) => {
      const updated = financials.map((f) => (f.id === id ? { ...f, ...updates } : f));
      setFinancials(updated);
      persistLocalCache(undefined, undefined, undefined, undefined, undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [financials, persistLocalCache]
  );

  const deleteFinancialRecord = useCallback(
    (id: string) => {
      const updated = financials.filter((f) => f.id !== id);
      setFinancials(updated);
      persistLocalCache(undefined, undefined, undefined, undefined, undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [financials, persistLocalCache]
  );

  // Settings
  const updateSettings = useCallback(
    (updates: Partial<StudioSettings>) => {
      const updated = { ...settings, ...updates };
      setSettings(updated);
      persistLocalCache(undefined, undefined, undefined, undefined, undefined, updated);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    },
    [settings, persistLocalCache]
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
      if (isSupabaseConfigured()) {
        const remoteData = await fetchRemoteStudioData();
        if (remoteData) {
          applyIncomingState(remoteData);
          setIsSyncing(false);
          return;
        }
      }
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        applyIncomingState(parsed);
      }
    } catch (e) {
      console.warn('Sync error:', e);
    } finally {
      setIsSyncing(false);
      setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
    }
  }, [applyIncomingState]);

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
        setProjects(parsed.projects);
        setClients(parsed.clients || []);
        setQuotes(parsed.quotes || []);
        setInventory(parsed.inventory || []);
        if (parsed.priceCatalog && Array.isArray(parsed.priceCatalog)) setPriceCatalog(parsed.priceCatalog);
        if (parsed.financials && Array.isArray(parsed.financials)) setFinancials(parsed.financials);
        if (parsed.settings) setSettings(parsed.settings);
        if (parsed.teamMembers) setTeamMembers(parsed.teamMembers);
        persistLocalCache(
          parsed.projects,
          parsed.clients || [],
          parsed.quotes || [],
          parsed.inventory || [],
          parsed.priceCatalog || DEFAULT_PRICE_CATALOG,
          parsed.settings || DEFAULT_SETTINGS,
          parsed.teamMembers || DEFAULT_TEAM,
          parsed.financials || DEFAULT_FINANCIAL_RECORDS
        );
        return true;
      } catch (e) {
        console.error('Invalid backup JSON:', e);
        return false;
      }
    },
    [persistLocalCache]
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
    persistLocalCache(
      DEFAULT_PROJECTS,
      DEFAULT_CLIENTS,
      DEFAULT_QUOTES,
      DEFAULT_INVENTORY,
      DEFAULT_PRICE_CATALOG,
      DEFAULT_SETTINGS,
      DEFAULT_TEAM,
      DEFAULT_FINANCIAL_RECORDS
    );
    setLastSyncedAt(new Date().toLocaleTimeString('it-IT'));
  }, [persistLocalCache]);

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
