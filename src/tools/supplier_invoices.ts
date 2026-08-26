import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { DolibarrAPI } from '../api.js';

export const supplierInvoiceTools: Tool[] = [
  { name: 'list_supplier_invoices', description: 'Lister les factures fournisseurs. Statut: 0=Brouillon, 1=Validée/Impayée, 2=Payée, 3=Abandonnée', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, page: { type: 'number' }, status: { type: 'number', description: '0=Brouillon, 1=Impayée, 2=Payée, 3=Abandonnée' }, thirdparty_ids: { type: 'string' }, sqlfilters: { type: 'string' } } } },
  { name: 'get_supplier_invoice', description: "Obtenir les détails d'une facture fournisseur", inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'create_supplier_invoice', description: 'Créer une facture fournisseur brouillon', inputSchema: { type: 'object', properties: { socid: { type: 'number', description: 'ID du fournisseur' }, ref_supplier: { type: 'string', description: 'Référence facture fournisseur' }, date: { type: 'string', description: 'Date ISO 8601' }, note_public: { type: 'string' }, cond_reglement_id: { type: 'number' }, mode_reglement_id: { type: 'number' } }, required: ['socid'] } },
  { name: 'add_supplier_invoice_line', description: "Ajouter une ligne à une facture fournisseur", inputSchema: { type: 'object', properties: { id: { type: 'number' }, desc: { type: 'string' }, subprice: { type: 'number' }, qty: { type: 'number' }, tva_tx: { type: 'number' }, fk_product: { type: 'number' } }, required: ['id', 'subprice', 'qty', 'tva_tx'] } },
  { name: 'validate_supplier_invoice', description: 'Valider une facture fournisseur brouillon', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'pay_supplier_invoice', description: 'Enregistrer un paiement sur une facture fournisseur', inputSchema: { type: 'object', properties: { id: { type: 'number' }, datepaye: { type: 'string' }, payment_mode_id: { type: 'number' }, accountid: { type: 'number' }, amount: { type: 'number' }, comment: { type: 'string' } }, required: ['id', 'datepaye', 'payment_mode_id'] } },
  { name: 'list_supplier_invoice_payments', description: "Lister les paiements rattachés à une facture fournisseur", inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'diagnose_supplier_invoice_deletion', description: "LECTURE SEULE : analyser si une facture fournisseur est supprimable. Vérifie paiements, statut payé, avoirs adossés, écritures comptables, commandes/réceptions liées et documents. Ne supprime rien.", inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'delete_supplier_invoice', description: "Supprimer UNE facture fournisseur via l'API REST native Dolibarr (DELETE /supplierinvoices/{id}). Analyse d'abord les dépendances et REFUSE automatiquement si une dépendance critique existe (paiement, avoir, écriture comptable). Ne supprime jamais le fournisseur, les produits, les commandes ni les réceptions. Traite une seule facture par appel : aucune suppression de masse possible.", inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID de la facture fournisseur à supprimer' }, force: { type: 'boolean', description: "Passer outre le refus automatique et laisser Dolibarr trancher. À n'utiliser qu'après analyse explicite des dépendances signalées. Défaut : false." } }, required: ['id'] } },
];

const SUPPLIER_INVOICE_STATUS: Record<string, string> = {
  '0': 'Brouillon', '1': 'Validée/Impayée', '2': 'Payée', '3': 'Abandonnée',
};

/** Dépendance empêchant (ou signalant un risque sur) la suppression. */
interface Dependency {
  type: string;
  critique: boolean;
  detail: string;
  solution: string;
}

interface Diagnosis {
  facture_id: number;
  ref: unknown;
  ref_supplier: unknown;
  fournisseur_id: unknown;
  total_ttc: unknown;
  statut: string;
  payee: boolean;
  supprimable: boolean;
  dependances: Dependency[];
  verifications_non_concluantes: string[];
}

/**
 * Analyse en lecture seule les dépendances d'une facture fournisseur.
 *
 * Les vérifications qui échouent (endpoint absent selon la version Dolibarr)
 * sont signalées comme non concluantes plutôt que considérées comme « aucune
 * dépendance » : l'absence de preuve n'est pas une preuve d'absence.
 */
async function diagnoseSupplierInvoice(id: number, api: DolibarrAPI): Promise<Diagnosis> {
  const invoice = await api.get<Record<string, any>>(`/supplierinvoices/${id}`);
  const dependencies: Dependency[] = [];
  const inconclusive: string[] = [];

  const statusCode = String(invoice.status ?? invoice.statut ?? '');
  const paid = String(invoice.paye ?? '0') === '1';

  // ── 1. Paiements rattachés ── critique
  let payments: Array<Record<string, unknown>> = [];
  try {
    const raw = await api.get<unknown>(`/supplierinvoices/${id}/payments`);
    if (Array.isArray(raw)) payments = raw as Array<Record<string, unknown>>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('404')) inconclusive.push(`paiements : ${message}`);
  }
  if (payments.length > 0) {
    dependencies.push({
      type: 'paiement',
      critique: true,
      detail: `${payments.length} paiement(s) : ` + payments
        .map((p) => `#${p.id ?? '?'} (ref ${p.ref ?? p.num_payment ?? '?'}, montant ${p.amount ?? '?'})`)
        .join(', '),
      solution: "Supprimer chaque paiement dans Dolibarr : Fournisseurs > Factures > la facture > onglet « Paiements » > ouvrir le paiement > Supprimer. L'API REST Dolibarr n'expose pas la suppression d'un paiement fournisseur, cette étape reste manuelle.",
    });
  }

  // ── 2. Statut payé sans paiement listé ── critique
  if (paid && payments.length === 0) {
    dependencies.push({
      type: 'statut',
      critique: true,
      detail: "Facture marquée « Payée » (paye=1) alors qu'aucun paiement n'est retourné par l'API.",
      solution: 'Vérifier les règlements dans Dolibarr et repasser la facture en impayée avant suppression.',
    });
  }

  // ── 3. Avoirs adossés ── critique
  try {
    const raw = await api.get<unknown>('/supplierinvoices', { limit: 100, sqlfilters: `(t.fk_facture_source:=:${id})` });
    const creditNotes = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
    if (creditNotes.length > 0) {
      dependencies.push({
        type: 'avoir',
        critique: true,
        detail: `${creditNotes.length} avoir(s) adossé(s) : ${creditNotes.map((c) => `#${c.id} ${c.ref ?? ''}`).join(', ')}`,
        solution: 'Supprimer ces avoirs avant la facture source : ils la référencent via fk_facture_source.',
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('404')) inconclusive.push(`avoirs : ${message}`);
  }

  // ── 4. Écritures comptables ── critique
  try {
    const raw = await api.get<unknown>('/accountancy/bookkeeping', {
      limit: 100,
      sqlfilters: `(t.doc_type:=:'supplier_invoice') and (t.fk_doc:=:${id})`,
    });
    const entries = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
    if (entries.length > 0) {
      dependencies.push({
        type: 'comptabilite',
        critique: true,
        detail: `${entries.length} écriture(s) comptable(s) ventilée(s) sur cette facture.`,
        solution: 'Annuler la ventilation comptable : Comptabilité > Grand livre / Ventilation, supprimer les écritures liées à cette pièce avant suppression.',
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('404')) inconclusive.push(`comptabilité : ${message}`);
  }

  // ── 5. Commandes fournisseur / réceptions liées ── signalé, NON critique.
  //    Dolibarr délie ces objets, il ne les supprime pas. Nous n'y touchons jamais.
  const linked = (invoice.linkedObjectsIds ?? invoice.linked_objects ?? {}) as Record<string, unknown>;
  for (const [objectType, ids] of Object.entries(linked)) {
    const list = Array.isArray(ids) ? ids : Object.values(ids ?? {});
    if (list.length === 0) continue;
    dependencies.push({
      type: `lien:${objectType}`,
      critique: false,
      detail: `${list.length} objet(s) « ${objectType} » lié(s) : ${list.join(', ')}`,
      solution: 'Aucune action requise : Dolibarr supprime uniquement le lien, pas la commande ni la réception. Ces objets sont conservés intacts.',
    });
  }

  const blocking = dependencies.some((d) => d.critique);

  return {
    facture_id: id,
    ref: invoice.ref,
    ref_supplier: invoice.ref_supplier,
    fournisseur_id: invoice.socid,
    total_ttc: invoice.total_ttc,
    statut: SUPPLIER_INVOICE_STATUS[statusCode] ?? `inconnu (${statusCode})`,
    payee: paid,
    supprimable: !blocking,
    dependances: dependencies,
    verifications_non_concluantes: inconclusive,
  };
}

export async function handleSupplierInvoiceTool(name: string, args: Record<string, unknown>, api: DolibarrAPI): Promise<string> {
  switch (name) {
    case 'list_supplier_invoices': {
      const params: Record<string, unknown> = { limit: args.limit || 100, page: args.page || 0 };
      if (args.status !== undefined) params.status = args.status;
      if (args.thirdparty_ids) params.thirdparty_ids = args.thirdparty_ids;
      if (args.sqlfilters) params.sqlfilters = args.sqlfilters;
      const data = await api.get('/supplierinvoices', params);
      return JSON.stringify(data, null, 2);
    }
    case 'get_supplier_invoice': {
      const data = await api.get(`/supplierinvoices/${args.id}`);
      return JSON.stringify(data, null, 2);
    }
    case 'create_supplier_invoice': {
      const date = args.date ? Math.floor(new Date(args.date as string).getTime() / 1000) : Math.floor(Date.now() / 1000);
      const id = await api.post('/supplierinvoices', { ...args, date, fk_user_author: Number(args.fk_user_author) || 1 });
      return `✅ Facture fournisseur créée. ID: ${id}`;
    }
    case 'add_supplier_invoice_line': {
      const { id, ...line } = args;
      const lineId = await api.post(`/supplierinvoices/${id}/lines`, line);
      return `✅ Ligne ajoutée à la facture fournisseur #${id}. ID ligne: ${lineId}`;
    }
    case 'validate_supplier_invoice': {
      await api.post(`/supplierinvoices/${args.id}/validate`, {});
      return `✅ Facture fournisseur #${args.id} validée.`;
    }
    case 'pay_supplier_invoice': {
      const datepaye = Math.floor(new Date(args.datepaye as string).getTime() / 1000);
      const invoice = await api.get<Record<string, unknown>>(`/supplierinvoices/${args.id}`);
      const amount = args.amount || (invoice.total_ttc as number);
      const payload = { datepaye, paiementid: args.payment_mode_id, accountid: args.accountid, comment: args.comment || '', amounts: { [args.id as string]: amount } };
      const payId = await api.post('/supplierinvoices/paymentsdistributed', payload);
      return `✅ Paiement de ${amount} FCFA enregistré sur la facture fournisseur #${args.id}. ID: ${payId}`;
    }
    case 'list_supplier_invoice_payments': {
      const data = await api.get(`/supplierinvoices/${args.id}/payments`);
      return JSON.stringify(data, null, 2);
    }
    case 'diagnose_supplier_invoice_deletion': {
      return JSON.stringify(await diagnoseSupplierInvoice(Number(args.id), api), null, 2);
    }
    case 'delete_supplier_invoice': {
      const id = Number(args.id);
      const force = args.force === true;

      // Garde-fous 1 à 3 : identifier, vérifier l'état, vérifier les dépendances.
      const diagnosis = await diagnoseSupplierInvoice(id, api);

      // Garde-fou 4 : refus automatique si une dépendance critique existe.
      if (!diagnosis.supprimable && !force) {
        return JSON.stringify({
          resultat: 'REFUS — dépendance critique détectée, aucune suppression effectuée',
          facture: { id, ref: diagnosis.ref, ref_supplier: diagnosis.ref_supplier, statut: diagnosis.statut },
          bloquants: diagnosis.dependances.filter((d) => d.critique),
          informatif: diagnosis.dependances.filter((d) => !d.critique),
          verifications_non_concluantes: diagnosis.verifications_non_concluantes,
          pour_passer_outre: "Traiter les dépendances ci-dessus, puis relancer. L'option force:true laisse Dolibarr trancher mais ne supprime jamais les objets liés.",
        }, null, 2);
      }

      // Suppression : API REST native, un seul objet, jamais les objets liés.
      try {
        await api.delete(`/supplierinvoices/${id}`);
        return JSON.stringify({
          resultat: 'SUPPRIMÉE',
          facture: { id, ref: diagnosis.ref, ref_supplier: diagnosis.ref_supplier },
          objets_preserves: 'Fournisseur, produits, commandes et réceptions liés sont intacts.',
          informatif: diagnosis.dependances.filter((d) => !d.critique),
        }, null, 2);
      } catch (error) {
        return JSON.stringify({
          resultat: 'ÉCHEC — Dolibarr a refusé la suppression, aucun forçage effectué',
          facture: { id, ref: diagnosis.ref, ref_supplier: diagnosis.ref_supplier, statut: diagnosis.statut },
          erreur_dolibarr: error instanceof Error ? error.message : String(error),
          dependances: diagnosis.dependances,
          verifications_non_concluantes: diagnosis.verifications_non_concluantes,
        }, null, 2);
      }
    }
    default: throw new Error(`Outil inconnu: ${name}`);
  }
}
