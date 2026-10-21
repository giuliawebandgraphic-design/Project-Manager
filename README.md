# Sage Paper Studio Manager 🌿
Gestionale professionale per Atelier di Partecipazioni, Stationery di Nozze, Calligrafia e Stampa Fine Art.

---

## 🚀 Guida al Deploy su Vercel

Questo progetto è preconfigurato al 100% per un deploy immediato su **Vercel** grazie al file `vercel.json` integrato.

### Metodo 1: Deploy Diretto da GitHub (Consigliato)
1. Carica questo repository su **GitHub** (es. `sage-paper-studio-manager`).
2. Accedi alla tua dashboard su [vercel.com](https://vercel.com) e clicca su **"Add New..." > "Project"**.
3. Seleziona il repository GitHub appena creato.
4. Vercel rileverà automaticamente la configurazione:
   - **Framework Preset**: `Vite`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
5. (Opzionale) Configura le **Environment Variables** in *Project Settings > Environment Variables*:
   - `APP_URL`: l'URL finale del tuo dominio Vercel (es. `https://sage-paper-studio.vercel.app`)
   - `GEMINI_API_KEY`: per le funzioni AI (opzionale)
   - `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`: per sincronizzazione cloud opzionale
6. Clicca su **Deploy**. In ~40 secondi il tuo studio e il portale clienti saranno live!

---

### Metodo 2: Deploy tramite Vercel CLI
1. Installa Vercel CLI globalmente (se non già installata):
   ```bash
   npm i -g vercel
   ```
2. Effettua il login e avvia il deploy:
   ```bash
   vercel
   ```
3. Per il deploy definitivo in produzione:
   ```bash
   vercel --prod
   ```

---

## 🛠️ Cosa è stato ottimizzato per Vercel
- **`vercel.json`**:
  - Routing SPA con `rewrites` per evitare errori 404 sui link diretti (`/#portal?token=...`).
  - Cache immutabile a lungo termine per gli asset hash-based (`/assets/*`).
  - Intestazioni di sicurezza moderne (`nosniff`, `strict-origin-when-cross-origin`).
  - Compatibilità per aperture nei webview (WhatsApp, Instagram, anteprime).
- **`favicon.svg` & `robots.txt`**: favicon SVG con sigillo atelier e protezione dai bot crawler per i link riservati dei clienti.
- **Node.js Engines**: compatibilità `Node.js >= 18.0.0` preimpostata in `package.json`.
- **Vite Build**: chunks ottimizzati e warning limits bilanciati.

---

## 💻 Esecuzione in Locale
1. Installa le dipendenze:
   ```bash
   npm install
   ```
2. Avvia il server di sviluppo:
   ```bash
   npm run dev
   ```
3. Verifica la build di produzione prima del deploy:
   ```bash
   npm run build
   npm run preview
   ```
