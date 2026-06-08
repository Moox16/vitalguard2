// js/db.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/+esm';

const SUPABASE_URL  = "https://ektychwtekgekblxtmnx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrdHljaHd0ZWtnZWtibHh0bW54Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MDIzNjIsImV4cCI6MjA5Mjk3ODM2Mn0.ucwNoAQPTndySkM-YKWabzyxrf6gFphOeLUJIJVwmI8";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Patients ─────────────────────────────────────────────────
export async function getPatients() {
  const { data, error } = await supabase.from('patients').select('*').order('name');
  if (error) throw error;
  return data;
}
export async function addPatient(p) {
  const { data, error } = await supabase.from('patients').insert([p]).select().single();
  if (error) throw error;
  return data;
}
export async function updatePatient(id, fields) {
  const { data, error } = await supabase.from('patients').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function deletePatient(id) {
  const { error } = await supabase.from('patients').delete().eq('id', id);
  if (error) throw error;
}

// ── Events ───────────────────────────────────────────────────
export async function getLatestEvent(patientId) {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getLatestEventsAll() {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  const seen = new Set();
  const latest = {};
  (data || []).forEach(e => {
    if (!seen.has(e.patient_id)) { seen.add(e.patient_id); latest[e.patient_id] = e; }
  });
  return latest;
}

export async function getAllEvents(limit = 200) {
  const { data, error } = await supabase
    .from('events')
    .select('*, patients(id, name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ── Alerts ───────────────────────────────────────────────────
export async function getAlerts(limit = 30) {
  const { data, error } = await supabase
    .from('alerts')
    .select('*, patients(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}
export async function createAlert(patientId, type, message) {
  const { error } = await supabase.from('alerts').insert([{ patient_id: patientId, type, message }]);
  if (error) throw error;
}
export async function resolveAlert(id) {
  const { error } = await supabase.from('alerts').update({ resolved: true }).eq('id', id);
  if (error) throw error;
}
export async function clearAlerts() {
  const { error } = await supabase.from('alerts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) throw error;
}
