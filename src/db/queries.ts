import { db, isPostgresConfigured } from './index.ts';
import * as schema from './schema.ts';
import { eq, desc, asc } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_PROJECTS,
  DEFAULT_CLIENTS,
  DEFAULT_QUOTES,
  DEFAULT_INVENTORY,
  DEFAULT_PRICE_CATALOG,
  DEFAULT_FINANCIAL_RECORDS,
} from '../lib/constants.ts';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'studio-store.json');

const DEFAULT_SETTINGS = {
  ownerHours: 30,
  collabHours: 4,
  buffer: 20,
  vat: 22,
  deposit: 40,
  gcalSyncEnabled: false,
  gcalCalendarId: 'primary',
};

interface StudioStoreData {
  clients: any[];
  projects: any[];
  quotes: any[];
  inventory: any[];
  settings: any;
  priceCatalog: any[];
  financials: any[];
}

function getInitialStoreData(): StudioStoreData {
  return {
    clients: JSON.parse(JSON.stringify(DEFAULT_CLIENTS)),
    projects: JSON.parse(JSON.stringify(DEFAULT_PROJECTS)),
    quotes: JSON.parse(JSON.stringify(DEFAULT_QUOTES)),
    inventory: JSON.parse(JSON.stringify(DEFAULT_INVENTORY)),
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    priceCatalog: JSON.parse(JSON.stringify(DEFAULT_PRICE_CATALOG)),
    financials: JSON.parse(JSON.stringify(DEFAULT_FINANCIAL_RECORDS)),
  };
}

function readStore(): StudioStoreData {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
      const initial = getInitialStoreData();
      fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf-8');
      return initial;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.projects)) {
      const initial = getInitialStoreData();
      fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf-8');
      return initial;
    }
    return parsed;
  } catch (err) {
    console.warn('Could not read store file, using in-memory initial data:', err);
    return getInitialStoreData();
  }
}

function writeStore(data: StudioStoreData): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing store file:', err);
  }
}

export function saveFullStudioStore(incomingData: Partial<StudioStoreData>): void {
  const current = readStore();
  const merged: StudioStoreData = {
    clients: Array.isArray(incomingData.clients) && incomingData.clients.length > 0 ? incomingData.clients : current.clients,
    projects: Array.isArray(incomingData.projects) && incomingData.projects.length > 0 ? incomingData.projects : current.projects,
    quotes: Array.isArray(incomingData.quotes) ? incomingData.quotes : current.quotes,
    inventory: Array.isArray(incomingData.inventory) ? incomingData.inventory : current.inventory,
    priceCatalog: Array.isArray(incomingData.priceCatalog) ? incomingData.priceCatalog : current.priceCatalog,
    financials: Array.isArray(incomingData.financials) ? incomingData.financials : current.financials,
    settings: incomingData.settings ? { ...current.settings, ...incomingData.settings } : current.settings,
  };
  writeStore(merged);
}

// ---------------------------------------------------------------------------
// 1. GET ALL STUDIO DATA
// ---------------------------------------------------------------------------
export async function getAllStudioData() {
  if (!isPostgresConfigured() || !db) {
    return readStore();
  }

  try {
    const [
      dbClients,
      dbProjects,
      dbTasks,
      dbProofs,
      dbFeedback,
      dbQuotes,
      dbQuoteItems,
      dbInventory,
      dbSettings,
      dbPriceCatalog,
      dbFinancials,
    ] = await Promise.all([
      db.select().from(schema.clients),
      db.select().from(schema.projects),
      db.select().from(schema.tasks).orderBy(asc(schema.tasks.sortOrder)),
      db.select().from(schema.proofs).orderBy(desc(schema.proofs.version)),
      db.select().from(schema.proofFeedback).orderBy(asc(schema.proofFeedback.createdAt)),
      db.select().from(schema.quotes),
      db.select().from(schema.quoteItems).orderBy(asc(schema.quoteItems.sortOrder)),
      db.select().from(schema.inventory),
      db.select().from(schema.studioSettings).where(eq(schema.studioSettings.id, 'current')).limit(1),
      db.select().from(schema.priceCatalog).orderBy(asc(schema.priceCatalog.sortOrder)),
      db.select().from(schema.financialRecords).orderBy(desc(schema.financialRecords.date)),
    ]);

    const proofsWithFeedback = dbProofs.map((prf: any) => ({
      ...prf,
      feedback: dbFeedback.filter((fb: any) => fb.proofId === prf.id),
    }));

    const projectsWithDetails = dbProjects.map((p: any) => ({
      ...p,
      tasks: dbTasks
        .filter((t: any) => t.projectId === p.id)
        .map((t: any) => ({
          ...t,
          hours: Number(t.hours) || 1,
        })),
      proofs: proofsWithFeedback.filter((prf: any) => prf.projectId === p.id),
    }));

    const quotesWithItems = dbQuotes.map((q: any) => ({
      ...q,
      discount: Number(q.discount) || 0,
      vatRate: Number(q.vatRate) || 22,
      depositPercent: Number(q.depositPercent) || 40,
      items: dbQuoteItems
        .filter((qi: any) => qi.quoteId === q.id)
        .map((qi: any) => ({
          ...qi,
          qty: Number(qi.qty) || 1,
          unit: Number(qi.unit) || 0,
        })),
    }));

    const formattedInventory = dbInventory.map((i: any) => ({
      ...i,
      qty: Number(i.qty) || 0,
      minimum: Number(i.minimum) || 10,
    }));

    const firstSetting = dbSettings[0];
    const formattedSettings = firstSetting
      ? {
          ownerHours: Number(firstSetting.ownerHours) || 30,
          collabHours: Number(firstSetting.collabHours) || 4,
          buffer: Number(firstSetting.buffer) || 20,
          vat: Number(firstSetting.vat) || 22,
          deposit: Number(firstSetting.deposit) || 40,
          gcalSyncEnabled: Boolean(firstSetting.gcalSyncEnabled),
          gcalCalendarId: firstSetting.gcalCalendarId || 'primary',
        }
      : null;

    const formattedPriceCatalog = dbPriceCatalog.map((c: any) => ({
      ...c,
      price: Number(c.price) || 0,
      minQty: Number(c.minQty) || 1,
      defaultHours: Number(c.defaultHours) || 0,
      description: c.description || '',
    }));

    const formattedFinancials = (dbFinancials || []).map((f: any) => ({
      ...f,
      amount: Number(f.amount) || 0,
    }));

    return {
      clients: dbClients,
      projects: projectsWithDetails,
      quotes: quotesWithItems,
      inventory: formattedInventory,
      settings: formattedSettings,
      priceCatalog: formattedPriceCatalog,
      financials: formattedFinancials,
    };
  } catch (error) {
    console.warn('Cloud SQL query failed, falling back to persistent store:', error);
    return readStore();
  }
}

// ---------------------------------------------------------------------------
// 2. PROJECTS
// ---------------------------------------------------------------------------
export async function createProjectRecord(project: any, tasksList: any[] = []) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    const newProj = {
      ...project,
      tasks: tasksList.map((t, idx) => ({ ...t, sortOrder: idx, hours: Number(t.hours) || 1 })),
      proofs: [],
    };
    store.projects.unshift(newProj);
    writeStore(store);
    return;
  }

  try {
    await db.insert(schema.projects).values({
      id: project.id,
      clientId: project.clientId || null,
      name: project.name,
      type: project.type,
      status: project.status,
      priority: project.priority,
      owner: project.owner,
      due: project.due,
      eventDate: project.eventDate || null,
      notes: project.notes || '',
      approved: Boolean(project.approved),
      approvedAt: project.approvedAt || null,
      approvedBy: project.approvedBy || null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });

    if (tasksList.length > 0) {
      await db.insert(schema.tasks).values(
        tasksList.map((t, idx) => ({
          id: t.id,
          projectId: project.id,
          name: t.name,
          owner: t.owner,
          hours: String(t.hours),
          leadDays: Number(t.leadDays) || 0,
          gate: t.gate || '',
          done: Boolean(t.done),
          doneAt: t.doneAt || null,
          sortOrder: idx,
        }))
      );
    }
  } catch (error) {
    console.warn('Cloud SQL insert error, saving to local store:', error);
    const store = readStore();
    const newProj = {
      ...project,
      tasks: tasksList.map((t, idx) => ({ ...t, sortOrder: idx, hours: Number(t.hours) || 1 })),
      proofs: [],
    };
    store.projects.unshift(newProj);
    writeStore(store);
  }
}

export async function updateProjectRecord(id: string, updates: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.projects = store.projects.map((p) => (p.id === id ? { ...p, ...updates } : p));
    writeStore(store);
    return;
  }

  try {
    await db.update(schema.projects).set(updates).where(eq(schema.projects.id, id));
  } catch (error) {
    console.warn('Cloud SQL update error, updating local store:', error);
    const store = readStore();
    store.projects = store.projects.map((p) => (p.id === id ? { ...p, ...updates } : p));
    writeStore(store);
  }
}

export async function deleteProjectRecord(id: string) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.projects = store.projects.filter((p) => p.id !== id);
    writeStore(store);
    return;
  }

  try {
    await db.delete(schema.projects).where(eq(schema.projects.id, id));
  } catch (error) {
    console.warn('Cloud SQL delete error, deleting from local store:', error);
    const store = readStore();
    store.projects = store.projects.filter((p) => p.id !== id);
    writeStore(store);
  }
}

// ---------------------------------------------------------------------------
// 3. TASKS
// ---------------------------------------------------------------------------
export async function insertTaskRecord(task: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (p.id !== task.projectId) return p;
      return { ...p, tasks: [...(p.tasks || []), { ...task, hours: Number(task.hours) || 1 }] };
    });
    writeStore(store);
    return;
  }

  try {
    await db.insert(schema.tasks).values({
      id: task.id,
      projectId: task.projectId,
      name: task.name,
      owner: task.owner,
      hours: String(task.hours),
      leadDays: Number(task.leadDays) || 0,
      gate: task.gate || '',
      done: Boolean(task.done),
      doneAt: task.doneAt || null,
      sortOrder: Number(task.sortOrder) || 0,
    });
  } catch (error) {
    console.warn('Cloud SQL task error, updating local store:', error);
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (p.id !== task.projectId) return p;
      return { ...p, tasks: [...(p.tasks || []), { ...task, hours: Number(task.hours) || 1 }] };
    });
    writeStore(store);
  }
}

export async function updateTaskRecord(id: string, updates: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (!p.tasks) return p;
      const updatedTasks = p.tasks.map((t: any) => (t.id === id ? { ...t, ...updates } : t));
      return { ...p, tasks: updatedTasks };
    });
    writeStore(store);
    return;
  }

  try {
    const formatted = { ...updates };
    if (formatted.hours !== undefined) formatted.hours = String(formatted.hours);
    await db.update(schema.tasks).set(formatted).where(eq(schema.tasks.id, id));
  } catch (error) {
    console.warn('Cloud SQL task error, updating local store:', error);
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (!p.tasks) return p;
      const updatedTasks = p.tasks.map((t: any) => (t.id === id ? { ...t, ...updates } : t));
      return { ...p, tasks: updatedTasks };
    });
    writeStore(store);
  }
}

export async function deleteTaskRecord(id: string) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (!p.tasks) return p;
      return { ...p, tasks: p.tasks.filter((t: any) => t.id !== id) };
    });
    writeStore(store);
    return;
  }

  try {
    await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
  } catch (error) {
    console.warn('Cloud SQL task delete error, updating local store:', error);
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (!p.tasks) return p;
      return { ...p, tasks: p.tasks.filter((t: any) => t.id !== id) };
    });
    writeStore(store);
  }
}

// ---------------------------------------------------------------------------
// 4. PROOFS & FEEDBACK
// ---------------------------------------------------------------------------
export async function insertProofRecord(proof: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (p.id !== proof.projectId) return p;
      return { ...p, proofs: [proof, ...(p.proofs || [])] };
    });
    writeStore(store);
    return;
  }

  try {
    await db.insert(schema.proofs).values({
      id: proof.id,
      projectId: proof.projectId,
      title: proof.title,
      version: Number(proof.version) || 1,
      fileUrl: proof.fileUrl,
      fileName: proof.fileName,
      fileSize: proof.fileSize || null,
      status: proof.status || 'pending',
      notes: proof.notes || null,
      uploadedBy: proof.uploadedBy,
      uploadedAt: proof.uploadedAt,
    });
  } catch (error) {
    console.warn('Cloud SQL proof error, updating local store:', error);
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (p.id !== proof.projectId) return p;
      return { ...p, proofs: [proof, ...(p.proofs || [])] };
    });
    writeStore(store);
  }
}

export async function updateProofRecord(id: string, updates: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (!p.proofs) return p;
      return {
        ...p,
        proofs: p.proofs.map((prf: any) => (prf.id === id ? { ...prf, ...updates } : prf)),
      };
    });
    writeStore(store);
    return;
  }

  try {
    await db.update(schema.proofs).set(updates).where(eq(schema.proofs.id, id));
  } catch (error) {
    console.warn('Cloud SQL proof update error, updating local store:', error);
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (!p.proofs) return p;
      return {
        ...p,
        proofs: p.proofs.map((prf: any) => (prf.id === id ? { ...prf, ...updates } : prf)),
      };
    });
    writeStore(store);
  }
}

export async function insertFeedbackRecord(feedback: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (!p.proofs) return p;
      return {
        ...p,
        proofs: p.proofs.map((prf: any) => {
          if (prf.id !== feedback.proofId) return prf;
          return { ...prf, feedback: [...(prf.feedback || []), feedback] };
        }),
      };
    });
    writeStore(store);
    return;
  }

  try {
    await db.insert(schema.proofFeedback).values({
      id: feedback.id,
      proofId: feedback.proofId || null,
      projectId: feedback.projectId,
      authorName: feedback.authorName,
      authorRole: feedback.authorRole,
      message: feedback.message,
      createdAt: feedback.createdAt,
    });
  } catch (error) {
    console.warn('Cloud SQL feedback error, updating local store:', error);
    const store = readStore();
    store.projects = store.projects.map((p) => {
      if (!p.proofs) return p;
      return {
        ...p,
        proofs: p.proofs.map((prf: any) => {
          if (prf.id !== feedback.proofId) return prf;
          return { ...prf, feedback: [...(prf.feedback || []), feedback] };
        }),
      };
    });
    writeStore(store);
  }
}

// ---------------------------------------------------------------------------
// 5. CLIENTS
// ---------------------------------------------------------------------------
export async function insertClientRecord(client: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.clients.unshift(client);
    writeStore(store);
    return;
  }

  try {
    await db.insert(schema.clients).values({
      id: client.id,
      name: client.name,
      email: client.email || '',
      phone: client.phone || '',
      type: client.type || 'Privato',
      companyName: client.companyName || null,
      taxId: client.taxId || null,
      notes: client.notes || '',
      portalToken: client.portalToken,
      portalEnabled: Boolean(client.portalEnabled),
      createdAt: client.createdAt,
      fiscalType: client.fiscalType || null,
      fiscalCode: client.fiscalCode || null,
      vatNumber: client.vatNumber || null,
      companyLegalName: client.companyLegalName || null,
      sdiCode: client.sdiCode || null,
      pec: client.pec || null,
      billingAddress: client.billingAddress || null,
      billingCap: client.billingCap || null,
      billingCity: client.billingCity || null,
      billingProvince: client.billingProvince || null,
      billingCountry: client.billingCountry || 'Italia',
      billingNotes: client.billingNotes || null,
      fiscalDataCompleted: Boolean(client.fiscalDataCompleted),
      fiscalDataUpdatedAt: client.fiscalDataUpdatedAt || null,
    });
  } catch (error) {
    console.warn('Cloud SQL client insert error, updating local store:', error);
    const store = readStore();
    store.clients.unshift(client);
    writeStore(store);
  }
}

export async function updateClientRecord(id: string, updates: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.clients = store.clients.map((c) => (c.id === id ? { ...c, ...updates } : c));
    writeStore(store);
    return;
  }

  try {
    await db.update(schema.clients).set(updates).where(eq(schema.clients.id, id));
  } catch (error) {
    console.warn('Cloud SQL client update error, updating local store:', error);
    const store = readStore();
    store.clients = store.clients.map((c) => (c.id === id ? { ...c, ...updates } : c));
    writeStore(store);
  }
}

export async function deleteClientRecord(id: string) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.clients = store.clients.filter((c) => c.id !== id);
    writeStore(store);
    return;
  }

  try {
    await db.delete(schema.clients).where(eq(schema.clients.id, id));
  } catch (error) {
    console.warn('Cloud SQL client delete error, updating local store:', error);
    const store = readStore();
    store.clients = store.clients.filter((c) => c.id !== id);
    writeStore(store);
  }
}

// ---------------------------------------------------------------------------
// 6. QUOTES
// ---------------------------------------------------------------------------
export async function insertQuoteRecord(quote: any, itemsList: any[] = []) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    const newQ = {
      ...quote,
      items: itemsList.map((it, idx) => ({ ...it, sortOrder: idx })),
    };
    store.quotes.unshift(newQ);
    writeStore(store);
    return;
  }

  try {
    await db.insert(schema.quotes).values({
      id: quote.id,
      clientId: quote.clientId || null,
      projectId: quote.projectId || null,
      name: quote.name,
      status: quote.status || 'draft',
      discount: String(quote.discount || 0),
      vatRate: String(quote.vatRate || 22),
      depositPercent: String(quote.depositPercent || 40),
      notes: quote.notes || '',
      created: quote.created,
    });

    if (itemsList.length > 0) {
      await db.insert(schema.quoteItems).values(
        itemsList.map((it, idx) => ({
          id: it.id,
          quoteId: quote.id,
          name: it.name,
          qty: String(it.qty || 1),
          unit: String(it.unit || 0),
          sortOrder: idx,
        }))
      );
    }
  } catch (error) {
    console.warn('Cloud SQL quote insert error, updating local store:', error);
    const store = readStore();
    const newQ = {
      ...quote,
      items: itemsList.map((it, idx) => ({ ...it, sortOrder: idx })),
    };
    store.quotes.unshift(newQ);
    writeStore(store);
  }
}

export async function updateQuoteRecord(id: string, updates: any, itemsList?: any[]) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.quotes = store.quotes.map((q) => {
      if (q.id !== id) return q;
      return {
        ...q,
        ...updates,
        items: itemsList !== undefined ? itemsList : q.items,
      };
    });
    writeStore(store);
    return;
  }

  try {
    const formatted: any = { ...updates };
    if (formatted.discount !== undefined) formatted.discount = String(formatted.discount);
    if (formatted.vatRate !== undefined) formatted.vatRate = String(formatted.vatRate);
    if (formatted.depositPercent !== undefined) formatted.depositPercent = String(formatted.depositPercent);

    await db.update(schema.quotes).set(formatted).where(eq(schema.quotes.id, id));

    if (itemsList) {
      await db.delete(schema.quoteItems).where(eq(schema.quoteItems.quoteId, id));
      if (itemsList.length > 0) {
        await db.insert(schema.quoteItems).values(
          itemsList.map((it, idx) => ({
            id: it.id,
            quoteId: id,
            name: it.name,
            qty: String(it.qty || 1),
            unit: String(it.unit || 0),
            sortOrder: idx,
          }))
        );
      }
    }
  } catch (error) {
    console.warn('Cloud SQL quote update error, updating local store:', error);
    const store = readStore();
    store.quotes = store.quotes.map((q) => {
      if (q.id !== id) return q;
      return {
        ...q,
        ...updates,
        items: itemsList !== undefined ? itemsList : q.items,
      };
    });
    writeStore(store);
  }
}

export async function deleteQuoteRecord(id: string) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.quotes = store.quotes.filter((q) => q.id !== id);
    writeStore(store);
    return;
  }

  try {
    await db.delete(schema.quotes).where(eq(schema.quotes.id, id));
  } catch (error) {
    console.warn('Cloud SQL quote delete error, updating local store:', error);
    const store = readStore();
    store.quotes = store.quotes.filter((q) => q.id !== id);
    writeStore(store);
  }
}

// ---------------------------------------------------------------------------
// 7. INVENTORY
// ---------------------------------------------------------------------------
export async function insertInventoryRecord(item: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.inventory.unshift({ ...item, qty: Number(item.qty) || 0, minimum: Number(item.minimum) || 10 });
    writeStore(store);
    return;
  }

  try {
    await db.insert(schema.inventory).values({
      id: item.id,
      name: item.name,
      unit: item.unit || 'pz',
      qty: String(item.qty || 0),
      minimum: String(item.minimum || 10),
      supplier: item.supplier || null,
    });
  } catch (error) {
    console.warn('Cloud SQL inventory insert error, updating local store:', error);
    const store = readStore();
    store.inventory.unshift({ ...item, qty: Number(item.qty) || 0, minimum: Number(item.minimum) || 10 });
    writeStore(store);
  }
}

export async function updateInventoryRecord(id: string, updates: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.inventory = store.inventory.map((i) => {
      if (i.id !== id) return i;
      const merged = { ...i, ...updates };
      if (merged.qty !== undefined) merged.qty = Number(merged.qty) || 0;
      if (merged.minimum !== undefined) merged.minimum = Number(merged.minimum) || 10;
      return merged;
    });
    writeStore(store);
    return;
  }

  try {
    const formatted: any = { ...updates };
    if (formatted.qty !== undefined) formatted.qty = String(formatted.qty);
    if (formatted.minimum !== undefined) formatted.minimum = String(formatted.minimum);
    await db.update(schema.inventory).set(formatted).where(eq(schema.inventory.id, id));
  } catch (error) {
    console.warn('Cloud SQL inventory update error, updating local store:', error);
    const store = readStore();
    store.inventory = store.inventory.map((i) => {
      if (i.id !== id) return i;
      const merged = { ...i, ...updates };
      if (merged.qty !== undefined) merged.qty = Number(merged.qty) || 0;
      if (merged.minimum !== undefined) merged.minimum = Number(merged.minimum) || 10;
      return merged;
    });
    writeStore(store);
  }
}

export async function deleteInventoryRecord(id: string) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.inventory = store.inventory.filter((i) => i.id !== id);
    writeStore(store);
    return;
  }

  try {
    await db.delete(schema.inventory).where(eq(schema.inventory.id, id));
  } catch (error) {
    console.warn('Cloud SQL inventory delete error, updating local store:', error);
    const store = readStore();
    store.inventory = store.inventory.filter((i) => i.id !== id);
    writeStore(store);
  }
}

// ---------------------------------------------------------------------------
// 8. STUDIO SETTINGS
// ---------------------------------------------------------------------------
export async function updateStudioSettingsRecord(updates: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.settings = { ...store.settings, ...updates };
    writeStore(store);
    return;
  }

  try {
    const formatted: any = {};
    if (updates.ownerHours !== undefined) formatted.ownerHours = String(updates.ownerHours);
    if (updates.collabHours !== undefined) formatted.collabHours = String(updates.collabHours);
    if (updates.buffer !== undefined) formatted.buffer = String(updates.buffer);
    if (updates.vat !== undefined) formatted.vat = String(updates.vat);
    if (updates.deposit !== undefined) formatted.deposit = String(updates.deposit);
    if (updates.gcalSyncEnabled !== undefined) formatted.gcalSyncEnabled = Boolean(updates.gcalSyncEnabled);
    if (updates.gcalCalendarId !== undefined) formatted.gcalCalendarId = updates.gcalCalendarId;

    await db
      .insert(schema.studioSettings)
      .values({ id: 'current', ...formatted })
      .onConflictDoUpdate({
        target: schema.studioSettings.id,
        set: formatted,
      });
  } catch (error) {
    console.warn('Cloud SQL settings update error, updating local store:', error);
    const store = readStore();
    store.settings = { ...store.settings, ...updates };
    writeStore(store);
  }
}

// ---------------------------------------------------------------------------
// 9. MASTER PRICE CATALOG
// ---------------------------------------------------------------------------
export async function insertPriceCatalogRecord(item: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.priceCatalog.push({
      ...item,
      price: Number(item.price) || 0,
      minQty: Number(item.minQty) || 1,
      defaultHours: Number(item.defaultHours) || 0,
    });
    writeStore(store);
    return;
  }

  try {
    await db.insert(schema.priceCatalog).values({
      id: item.id,
      name: item.name,
      price: String(item.price || 0),
      category: item.category || 'Wedding Suite',
      description: item.description || '',
      minQty: String(item.minQty || 1),
      defaultHours: String(item.defaultHours || 0),
      sortOrder: Number(item.sortOrder) || 0,
    });
  } catch (error) {
    console.warn('Cloud SQL price catalog insert error, updating local store:', error);
    const store = readStore();
    store.priceCatalog.push({
      ...item,
      price: Number(item.price) || 0,
      minQty: Number(item.minQty) || 1,
      defaultHours: Number(item.defaultHours) || 0,
    });
    writeStore(store);
  }
}

export async function updatePriceCatalogRecord(id: string, updates: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.priceCatalog = store.priceCatalog.map((it) => (it.id === id ? { ...it, ...updates } : it));
    writeStore(store);
    return;
  }

  try {
    const formatted: any = { ...updates };
    if (formatted.price !== undefined) formatted.price = String(formatted.price);
    if (formatted.minQty !== undefined) formatted.minQty = String(formatted.minQty);
    if (formatted.defaultHours !== undefined) formatted.defaultHours = String(formatted.defaultHours);
    await db.update(schema.priceCatalog).set(formatted).where(eq(schema.priceCatalog.id, id));
  } catch (error) {
    console.warn('Cloud SQL price catalog update error, updating local store:', error);
    const store = readStore();
    store.priceCatalog = store.priceCatalog.map((it) => (it.id === id ? { ...it, ...updates } : it));
    writeStore(store);
  }
}

export async function deletePriceCatalogRecord(id: string) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.priceCatalog = store.priceCatalog.filter((it) => it.id !== id);
    writeStore(store);
    return;
  }

  try {
    await db.delete(schema.priceCatalog).where(eq(schema.priceCatalog.id, id));
  } catch (error) {
    console.warn('Cloud SQL price catalog delete error, updating local store:', error);
    const store = readStore();
    store.priceCatalog = store.priceCatalog.filter((it) => it.id !== id);
    writeStore(store);
  }
}

// ---------------------------------------------------------------------------
// 10. FINANCIAL RECORDS (BILANCIO, ENTRATE, SPESE)
// ---------------------------------------------------------------------------
export async function insertFinancialRecord(record: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.financials.unshift({ ...record, amount: Number(record.amount) || 0 });
    writeStore(store);
    return;
  }

  try {
    await db.insert(schema.financialRecords).values({
      id: record.id,
      projectId: record.projectId || null,
      type: record.type || 'expense',
      category: record.category || 'materials',
      title: record.title,
      amount: String(record.amount || 0),
      date: record.date,
      status: record.status || 'paid',
      supplierOrClient: record.supplierOrClient || null,
      notes: record.notes || '',
      invoiceNumber: record.invoiceNumber || null,
      createdAt: record.createdAt,
    });
  } catch (error) {
    console.warn('Cloud SQL finance insert error, updating local store:', error);
    const store = readStore();
    store.financials.unshift({ ...record, amount: Number(record.amount) || 0 });
    writeStore(store);
  }
}

export async function updateFinancialRecord(id: string, updates: any) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.financials = store.financials.map((f) => {
      if (f.id !== id) return f;
      const merged = { ...f, ...updates };
      if (merged.amount !== undefined) merged.amount = Number(merged.amount) || 0;
      return merged;
    });
    writeStore(store);
    return;
  }

  try {
    const formatted: any = { ...updates };
    if (formatted.amount !== undefined) formatted.amount = String(formatted.amount);
    await db.update(schema.financialRecords).set(formatted).where(eq(schema.financialRecords.id, id));
  } catch (error) {
    console.warn('Cloud SQL finance update error, updating local store:', error);
    const store = readStore();
    store.financials = store.financials.map((f) => {
      if (f.id !== id) return f;
      const merged = { ...f, ...updates };
      if (merged.amount !== undefined) merged.amount = Number(merged.amount) || 0;
      return merged;
    });
    writeStore(store);
  }
}

export async function deleteFinancialRecord(id: string) {
  if (!isPostgresConfigured() || !db) {
    const store = readStore();
    store.financials = store.financials.filter((f) => f.id !== id);
    writeStore(store);
    return;
  }

  try {
    await db.delete(schema.financialRecords).where(eq(schema.financialRecords.id, id));
  } catch (error) {
    console.warn('Cloud SQL finance delete error, updating local store:', error);
    const store = readStore();
    store.financials = store.financials.filter((f) => f.id !== id);
    writeStore(store);
  }
}
