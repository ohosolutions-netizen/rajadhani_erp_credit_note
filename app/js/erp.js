import { decodeResponse } from './core.js';
export class ERP {
  constructor(config, sdk) { this.config = config; this.sdk = sdk; this.ready = false; }
  async init() {
    if (!this.sdk) throw new Error('Open this widget inside Zoho ERP to connect to your records.');
    await this.sdk.extension.init();
    const context = await this.sdk.get('organization');
    this.organization = context.organization || context;
    this.config.organizationId ||= String(this.organization.organization_id || '');
    this.ready = true;
    // Physical screen dimensions overestimate the usable browser viewport.
    // Read the host viewport when same-origin; otherwise reserve generous chrome margins.
    let viewportWidth = window.outerWidth || 1100;
    let viewportHeight = window.outerHeight || 800;
    try {
      viewportWidth = window.top.innerWidth;
      viewportHeight = window.top.innerHeight;
    } catch { /* Cross-origin host: use conservative browser-window bounds. */ }
    const width = Math.max(760, Math.min(1280, viewportWidth - 260));
    const height = Math.max(520, Math.min(820, viewportHeight - 90));
    try {
      await this.sdk.invoke('RESIZE', { width: `${width}px`, height: `${height}px` });
    } catch { /* Host may constrain popup dimensions. */ }
    return this.organization;
  }
  async request(path, query = {}, method = 'GET', payload) {
    if (!this.ready) throw new Error('ERP is not connected. Open the widget inside Zoho ERP.');
    if (!this.config.connectionLinkName || !this.config.organizationId) throw new Error('Complete the ERP connection settings to load records.');
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Lookup paths must be relative ERP API paths.');
    const options = {
      url: `${this.config.apiBase.replace(/\/$/, '')}${path}`, method,
      url_query: Object.entries({ organization_id: this.config.organizationId, ...query }).filter(([,v]) => v !== '' && v != null).map(([key, value]) => ({ key, value: String(value) })),
      connection_link_name: this.config.connectionLinkName
    };
    if (payload) {
      options.header = [{ key: 'Content-Type', value: 'application/json' }];
      options.body = { mode: 'raw', raw: JSON.stringify(payload) };
    }
    let response;
    try {
      response = await this.sdk.request(options);
      const decoded = decodeResponse(response);
      if (method === 'POST' && path === '/creditnotes') this.lastCreateResponse = response;
      return decoded;
    } catch (err) {
      if (!(err instanceof Error)) err = Object.assign(new Error(typeof err === 'string' ? err : err?.message || 'SDK request failed'), {sdkError: err});
      err.requestDiagnostics = {method, url: options.url, query: Object.fromEntries(options.url_query.map(q=>[q.key,q.value])), payload, response: response ?? err.sdkError ?? err.response ?? err.data ?? null, originalMessage: err.message};
      if (/not authorized|permission|oauth|scope/i.test(err.message || '')) {
        const scope = path.startsWith('/contacts') ? 'ERP.contacts.READ' : path.startsWith('/salesorders') ? 'ERP.salesorders.READ' : path.startsWith('/creditnotes') ? (method === 'GET' ? 'ERP.creditnotes.READ' : 'ERP.creditnotes.CREATE') : path.startsWith('/invoices') ? 'ERP.invoices.READ' : 'ERP.settings.READ';
        err.message = `Access denied for ${path}. Check ${scope} in erp_admin, reauthorize the connection for the current user, and verify access to organization ${this.config.organizationId}.`;
      }
      throw err;
    }
  }
  async all(path, key, query = {}) {
    const records = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.request(path, { ...query, page, per_page: 200 });
      if (!Array.isArray(result[key])) throw new Error(`ERP did not return ${key} for ${path}. Check the configured lookup.`);
      records.push(...result[key]);
      const context = Array.isArray(result.page_context) ? result.page_context[0] : result.page_context;
      if (!context?.has_more_page) return records;
    }
    throw new Error(`Too many records in ${path}; configure a narrower lookup.`);
  }
  async salespersons() {
    const normalize = records => records
      .filter(r => r.status !== 'inactive' && r.is_active !== false)
      .map(r => ({
        salesperson_id: String(r.salesperson_id || r.user_id || r.id || ''),
        salesperson_name: r.salesperson_name || r.name || r.full_name || r.email || r.user_name || String(r.salesperson_id || r.user_id || r.id || '')
      }))
      .filter(r => r.salesperson_id && r.salesperson_name);
    try {
      const result = await this.request('/salespersons', { page: 1, per_page: 200 });
      const records = result.salespersons || result.users || result.data;
      if (Array.isArray(records)) return normalize(records);
    } catch {
      // Not every ERP tenant exposes a salespersons endpoint.
    }
    return normalize(await this.all('/users', 'users'));
  }
  async searchCustomers(text, page = 1) {
    const query = text.trim();
    const result = await this.request('/contacts', { contact_type: 'customer', contact_name_contains: query, page, per_page: 25 });
    // Some ERP tenants ignore search_text; use the documented name filter and
    // never display unrelated records if the server ignores that filter too.
    if (query && Array.isArray(result.contacts)) {
      const needle = query.normalize('NFKC').toLocaleLowerCase();
      result.contacts = result.contacts.filter(c => String(c.contact_name || '').normalize('NFKC').toLocaleLowerCase().includes(needle));
    }
    return result;
  }
  searchItems(text, page = 1) { return this.request('/items', { search_text: text, page, per_page: 25 }); }
  async customer(id) { return (await this.request(`/contacts/${encodeURIComponent(id)}`)).contact; }
  async item(id) { return (await this.request(`/items/${encodeURIComponent(id)}`)).item; }
  async itemMaster(id) { return (await this.request(`/itemmasters/${encodeURIComponent(id)}`)).item_master; }
  async itemTransactions(customerId, itemId) {
    const invoices = await this.all('/invoices', 'invoices', {customer_id: customerId});
    const rows = [];
    // Fetch details because list responses do not reliably include line items.
    // Bounded batches avoid flooding the connection while retaining every page.
    for (let offset=0; offset<invoices.length; offset+=4) {
      const details = await Promise.all(invoices.slice(offset,offset+4).map(async summary => {
        const result = await this.request(`/invoices/${encodeURIComponent(summary.invoice_id)}`);
        if (!result.invoice || !Array.isArray(result.invoice.line_items)) throw new Error('ERP returned incomplete invoice details.');
        return result.invoice;
      }));
      for (const invoice of details) {
        if (String(invoice.customer_id) !== String(customerId)) continue;
        for (const line of invoice.line_items) {
          if (String(line.item_id) !== String(itemId)) continue;
          const quantity=Number(line.quantity), rate=Number(line.rate);
          const gross=quantity*rate;
          const discount = typeof line.discount === 'string' && line.discount.includes('%') ? parseFloat(line.discount) : Number(line.discount_amount ?? line.discount ?? 0) / (gross || 1) * 100;
          rows.push({invoiceId:String(invoice.invoice_id),lineId:String(line.line_item_id || ''),customerId:String(invoice.customer_id),number:invoice.invoice_number || invoice.invoice_id,reference:invoice.reference_number || '',date:invoice.date,status:invoice.status,quantity,rate,discount,
            taxId:String(line.tax_id || line.tax_group_id || ''),taxName:line.tax_name,taxPercentage:Number(line.tax_percentage || 0),exemption:line.tax_exemption_id,locationId:line.location_id || invoice.location_id,currency:invoice.currency_code,supply:invoice.place_of_supply,inclusive:invoice.is_inclusive_tax,headerDiscount:invoice.discount_type === 'entity_level' && Number(invoice.discount_total || invoice.discount || 0) !== 0,
            selectable:!['draft','void','cancelled'].includes(invoice.status) && !!line.line_item_id && quantity>0 && Number.isFinite(rate) && Number.isFinite(discount)});
        }
      }
    }
    return rows.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  }
  createCreditNote(payload) {
    const invoices = [...new Set(payload.line_items.map(line=>line.invoice_id).filter(Boolean))];
    const query = {ignore_auto_number_generation: false};
    if (invoices.length === 1 && payload.line_items.every(line=>line.invoice_id === invoices[0])) query.invoice_id = invoices[0];
    return this.request('/creditnotes', query, 'POST', payload);
  }
  async inspectCreation(payload) {
    const checks = [];
    const read = async (label, path, query={}) => {
      try { const data=await this.request(path,query); checks.push({label,path,query,data}); return data; }
      catch(e) { checks.push({label,path,query,error:e.message,response:e.erpResponse || e.requestDiagnostics?.response || null}); return null; }
    };
    await read('Customer', `/contacts/${encodeURIComponent(payload.customer_id)}`);
    const invoices=[...new Set(payload.line_items.map(l=>l.invoice_id).filter(Boolean))];
    for(const id of invoices.slice(0,5)) await read('Source invoice', `/invoices/${encodeURIComponent(id)}`);
    const items=[...new Set(payload.line_items.map(l=>l.item_id).filter(Boolean))];
    for(const id of items.slice(0,5)) await read('Item master', `/items/${encodeURIComponent(id)}`);
    const list=await read('Existing Credit Notes for this customer', '/creditnotes', {customer_id:payload.customer_id,page:1,per_page:10});
    const existing=list?.creditnotes?.find(c=>String(c.customer_id)===String(payload.customer_id));
    if(existing?.creditnote_id) await read('Existing Credit Note details', `/creditnotes/${encodeURIComponent(existing.creditnote_id)}`);
    return {readOnly:true,limit:'First five unique source invoices/items; one existing Credit Note for the same customer, if available.',checks};
  }
}
