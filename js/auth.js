// js/auth.js
import { supabase } from './db.js';

export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}
export async function logout() {
  await supabase.auth.signOut();
  window.location.href = 'index.html';
}
export async function requireAuth() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) { window.location.href = 'index.html'; return null; }
  return data.session.user;
}
