import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Read from Vite environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export let supabase: SupabaseClient | null = null;

// Allow dynamic client re-initialization if configured in UI Settings
export function initSupabase(url: string, key: string): SupabaseClient | null {
  if (!url || !key || !url.startsWith('http')) {
    supabase = null;
    return null;
  }
  try {
    supabase = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
    return supabase;
  } catch (err) {
    console.error('Failed to initialize Supabase client:', err);
    supabase = null;
    return null;
  }
}

// Initial initialization if env vars exist
if (supabaseUrl && supabaseAnonKey && supabaseUrl.startsWith('http')) {
  initSupabase(supabaseUrl, supabaseAnonKey);
}

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}

/**
 * Save complete studio state to remote Supabase database
 */
export async function saveRemoteStudioData(data: any): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase
      .from('studio_state')
      .upsert({
        id: 'main',
        data,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) {
      console.warn('Supabase save error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Supabase remote sync warning:', err);
    return false;
  }
}

/**
 * Fetch latest studio state from remote Supabase database
 */
export async function fetchRemoteStudioData(): Promise<any | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('studio_state')
      .select('data, updated_at')
      .eq('id', 'main')
      .single();

    if (error || !data) return null;
    return data.data;
  } catch (err) {
    console.warn('Supabase remote fetch warning:', err);
    return null;
  }
}
