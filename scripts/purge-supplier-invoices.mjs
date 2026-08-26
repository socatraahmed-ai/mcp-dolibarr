#!/usr/bin/env node
/**
 * scripts/purge-supplier-invoices.mjs
 *
 * Purge contrôlée des factures fournisseurs d'une instance Dolibarr de TEST.
 *
 * Le script s'appuie sur l'outil `delete_supplier_invoice` du connecteur MCP :
 * les garde-fous sont donc rigoureusement identiques à ceux appliqués lors d'un
 * usage conversationnel, sans duplication de logique.
 *
 * Sécurités :
 *   - simulation par défaut, la suppression exige --execute ;
 *   - refus catégorique des hôtes de production ;
 *   - vérification de la cible (URL, société, version) avant toute écriture ;
 *   - confirmation explicite du nom de société via --confirm-company ;
 *   - sauvegarde complète avant la première suppression ;
 *   - aucune suppression de fournisseur, produit, commande ou réception.
 *
 * Prérequis : npm install && npm run build
 *
 * Usage :
 *   node scripts/purge-supplier-invoices.mjs
 *   node scripts/purge-supplier-invoices.mjs --execute --confirm-company "MA SOCIETE TEST"
 *
 * Digital Factory Senegal — https://digitalfactory.sn
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Hôtes formellement interdits : production. */
const PRODUCTION_DENYLIST = ['erp.digitalfactory.sn'];

/** Marqueurs d'un hôte de recette/test. */
const TEST_MARKERS = ['test', 'staging', 'recette', 'preprod', 'sandbox', 'dev', 'local', '192.168.', '10.', '127.0.0.1'];

// ─────────────────────────── Utilitaires ───────────────────────────

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function fail(message) {
  console.error(`\n${red('✖ ARRÊT')} — ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { execute: false, confirmCompany: null, pageSize: 100, out: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--execute': args.execute = true; break;
      case '--confirm-company': args.confirmCompany = argv[++i] ?? null; break;
      case '--page-size': args.pageSize = Number(argv[++i]); break;
      case '--out': args.out = argv[++i] ?? null; break;
      case '--help': case '-h': args.help = true; break;
      default: fail(`Option inconnue : ${argv[i]}`);
    }
  }
  return args;
}

/** Charge .env sans écraser les variables déjà définies. La clé n'est jamais affichée. */
function loadDotEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Normalise pour comparer un nom de société (casse et accents ignorés). */
const normalize = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

// ─────────────────────────── Programme ───────────────────────────

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 26).join('\n').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

loadDotEnv();

const DOLIBARR_URL = process.env.DOLIBARR_URL;
const DOLIBARR_API_KEY = process.env.DOLIBARR_API_KEY;

if (!DOLIBARR_URL || !DOLIBARR_API_KEY) {
  fail("DOLIBARR_URL et DOLIBARR_API_KEY sont requis.\n  Renseignez-les dans le fichier .env à la racine du projet (jamais dans le code source).");
}

// ── Garde-fou : production formellement interdite ──
const host = (() => { try { return new URL(DOLIBARR_URL).host; } catch { return DOLIBARR_URL; } })();
for (const banned of PRODUCTION_DENYLIST) {
  if (host.includes(banned)) {
    fail(`L'hôte « ${host} » figure sur la liste noire de production. Ce script refuse d'y toucher.`);
  }
}

// ── Chargement du connecteur compilé (source unique des garde-fous) ──
if (!existsSync(join(ROOT, 'build', 'api.js'))) {
  fail('Le connecteur n\'est pas compilé. Lancez d\'abord :  npm install && npm run build');
}
const moduleUrl = (...parts) => pathToFileURL(join(ROOT, ...parts)).href;
const { DolibarrAPI } = await import(moduleUrl('build', 'api.js'));
const { handleSupplierInvoiceTool } = await import(moduleUrl('build', 'tools', 'supplier_invoices.js'));
const { handleSetupTool } = await import(moduleUrl('build', 'tools', 'setup.js'));

const api = new DolibarrAPI(DOLIBARR_URL, DOLIBARR_API_KEY);

// ─── ÉTAPE 1-3 : vérification de la cible ───
console.log(bold('\n═══ VÉRIFICATION DE LA CIBLE ═══\n'));

let version = 'inconnue';
try {
  const status = JSON.parse((await handleSetupTool('get_status', {}, api)).replace(/^[^{]*/, ''));
  version = status?.dolibarr_version ?? status?.success?.dolibarr_version ?? 'inconnue';
} catch (error) {
  fail(`Impossible de joindre l'API Dolibarr (GET /status) : ${error.message}`);
}

let company = 'inconnue';
try {
  const info = JSON.parse(await handleSetupTool('get_company_info', {}, api));
  company = info?.name ?? info?.nom ?? 'inconnue';
} catch (error) {
  console.error(yellow(`  ⚠ Nom de société illisible (GET /setup/company) : ${error.message}`));
}

console.log(`  URL cible        : ${bold(api.baseURL)}`);
console.log(`  Société          : ${bold(company)}`);
console.log(`  Version Dolibarr : ${bold(version)}`);

const looksLikeTest = TEST_MARKERS.some((m) => host.includes(m));
console.log(`  Profil d'hôte    : ${looksLikeTest ? green('compatible TEST') : yellow('NON identifié comme TEST')}`);

// ─── ÉTAPE 4 : confirmation explicite avant toute écriture ───
if (!args.execute) {
  console.log(yellow(bold('\n  MODE SIMULATION — aucune suppression ne sera effectuée.')));
  console.log(`  Pour exécuter réellement :\n    node scripts/purge-supplier-invoices.mjs --execute --confirm-company "${company}"\n`);
} else {
  if (!args.confirmCompany) {
    fail(`Mode --execute : confirmation requise.\n  Relancez avec :  --confirm-company "${company}"`);
  }
  if (normalize(args.confirmCompany) !== normalize(company)) {
    fail(`La confirmation « ${args.confirmCompany} » ne correspond pas à la société cible « ${company} ».\n  Suppression annulée : vous ne visez peut-être pas l'instance attendue.`);
  }
  console.log(green(bold('\n  ✔ Cible confirmée — mode SUPPRESSION RÉELLE activé.')));
}

// ─── Inventaire ───
console.log(bold('\n═══ INVENTAIRE ═══\n'));

async function fetchAllInvoices() {
  const all = [];
  for (let page = 0; ; page++) {
    let batch;
    try {
      batch = JSON.parse(await handleSupplierInvoiceTool('list_supplier_invoices', { limit: args.pageSize, page }, api));
    } catch (error) {
      if (String(error.message).includes('404')) break; // Dolibarr renvoie 404 sur liste vide
      throw error;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < args.pageSize) break;
  }
  return all;
}

const invoices = await fetchAllInvoices();
console.log(`  Factures fournisseurs trouvées : ${bold(invoices.length)}`);

if (invoices.length === 0) {
  console.log(green(bold('\n  FACTURES FOURNISSEURS = 0 — rien à faire.\n')));
  process.exit(0);
}

// ─── Sauvegarde ───
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = args.out ?? join(ROOT, 'backups', `supplier-invoices-${stamp}`);
mkdirSync(outDir, { recursive: true });

console.log(bold('\n═══ SAUVEGARDE ═══\n'));

const backup = [];
for (const invoice of invoices) {
  const record = { resume: invoice };
  try { record.detail = JSON.parse(await handleSupplierInvoiceTool('get_supplier_invoice', { id: invoice.id }, api)); } catch (e) { record.detail_erreur = e.message; }
  try { record.paiements = JSON.parse(await handleSupplierInvoiceTool('list_supplier_invoice_payments', { id: invoice.id }, api)); } catch { record.paiements = []; }
  backup.push(record);
  process.stdout.write(`\r  Sauvegardées : ${backup.length}/${invoices.length}`);
}

writeFileSync(join(outDir, 'factures-fournisseurs.json'), JSON.stringify(backup, null, 2));
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
  date: new Date().toISOString(), url: api.baseURL, societe: company, version_dolibarr: version, nombre: invoices.length,
}, null, 2));
console.log(`\n  ${green('✔')} Sauvegarde écrite dans ${bold(outDir)}`);

// ─── Traitement facture par facture ───
console.log(bold(`\n═══ ${args.execute ? 'SUPPRESSION' : 'ANALYSE (simulation)'} ═══\n`));

const deleted = [];
const deletable = [];
const blocked = [];

for (const invoice of invoices) {
  const label = invoice.ref ?? `#${invoice.id}`;
  const tool = args.execute ? 'delete_supplier_invoice' : 'diagnose_supplier_invoice_deletion';
  const result = JSON.parse(await handleSupplierInvoiceTool(tool, { id: Number(invoice.id) }, api));

  const isDeleted = result.resultat === 'SUPPRIMÉE';
  const isDeletable = result.supprimable === true;

  if (isDeleted) {
    deleted.push({ id: invoice.id, ref: label });
    console.log(`  ${green('✔')} ${label} — supprimée`);
  } else if (!args.execute && isDeletable) {
    deletable.push({ id: invoice.id, ref: label });
    console.log(`  ${green('○')} ${label} — supprimable`);
  } else {
    const deps = (result.bloquants ?? result.dependances ?? []).filter((d) => d.critique !== false);
    blocked.push({
      id: invoice.id,
      ref: label,
      ref_supplier: invoice.ref_supplier ?? result.facture?.ref_supplier ?? '',
      statut: result.facture?.statut ?? result.statut ?? '',
      erreur: result.erreur_dolibarr ?? null,
      dependances: deps,
    });
    console.log(`  ${red('✖')} ${label} — bloquée (${deps.map((d) => d.type).join(', ') || 'refus Dolibarr'})`);
  }
}

// ─── Vérification finale réelle ───
console.log(bold('\n═══ VÉRIFICATION FINALE ═══\n'));

const remaining = await fetchAllInvoices();

writeFileSync(join(outDir, 'rapport.json'), JSON.stringify({
  mode: args.execute ? 'execution' : 'simulation',
  total: invoices.length,
  supprimables: deletable, supprimees: deleted, bloquees: blocked,
  restantes: remaining.length,
}, null, 2));

if (blocked.length > 0) {
  console.log(bold('  Factures NON supprimées :\n'));
  for (const b of blocked) {
    console.log(`  ${bold(b.ref)}${b.ref_supplier ? ` (réf. fournisseur ${b.ref_supplier})` : ''} — ${b.statut}`);
    if (b.erreur) console.log(`     Refus Dolibarr : ${b.erreur}`);
    for (const d of b.dependances) {
      console.log(`     • Dépendance : ${bold(d.type)}`);
      console.log(`       Raison   : ${d.detail}`);
      console.log(`       Solution : ${d.solution}`);
    }
    console.log('');
  }
}

const count = remaining.length;
if (args.execute) {
  console.log(count === 0
    ? green(bold('  FACTURES FOURNISSEURS = 0'))
    : yellow(bold(`  FACTURES RESTANTES = ${count}`)));
  console.log(`\n  Total traité : ${invoices.length}   Supprimées : ${deleted.length}   Bloquées : ${blocked.length}`);
} else {
  console.log(bold('  SYNTHÈSE — aucune facture touchée\n'));
  console.log(`  Total factures fournisseurs : ${bold(invoices.length)}`);
  console.log(`  Supprimables                : ${green(bold(deletable.length))}`);
  console.log(`  Bloquées                    : ${blocked.length ? red(bold(blocked.length)) : bold('0')}`);
}
console.log(`  Rapport complet : ${join(outDir, 'rapport.json')}\n`);

process.exit(args.execute && count > 0 ? 2 : 0);
