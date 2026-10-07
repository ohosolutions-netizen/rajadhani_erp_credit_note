# Rajadhani Credit Note — Zoho ERP widget

Credit Note / sales return entry adapted from the working Invoice widget. Customer lookup, item/SKU scanning, M Unit/Ratio packing, GST component rounding, addresses, business fields and review remain available. It creates a **draft Credit Note**, never an invoice, and does not email, refund, or apply credits automatically.

## Item → Bill workflow

1. Select a customer, then select or scan an item code.
2. Click **Select bill** in the item's **Bill No.** column.
3. The dialog loads every page of that customer's invoices and inspects every invoice line for the selected item. It includes paid invoices and repeated occurrences of an item, with bill number, reference, date, status, original quantity and rate. Filter by number/reference/date. Draft and void transactions are visible but cannot be selected.
4. Select the original transaction. Bill/reference/date fill the row; its rate, discount and tax are copied. Enter the return quantity. Add the same item again to return against another bill.
5. Review and save. Each Credit Note line sends the documented `invoice_id` and `invoice_item_id`, plus a readable bill reference in its description. The request is `POST /creditnotes` with `is_draft: true`.

Changing the customer clears existing rows. Missing bills, mismatched customers/place of supply, future bill dates, invalid quantities and aggregate returns above the selected invoice line quantity block review. Zero discount is valid. Source invoice taxes are preserved. The server remains authoritative for previous credits, remaining return eligibility, accounting and stock movement; displayed quantities are **original billed quantities**, not an assertion of remaining returnable stock. No refund or invoice-credit application call is made.

## Deploy

- Upload package: **`dist/RajadhaniCreditNote.zip`**.
- Standalone sample preview: **`dist/CreditNotePreview.html`** (saving disabled).
- Screenshot: `dist/CreditNotePreview.png`.
- Source: `app/`; no runtime npm dependencies are shipped.

The manifest uses `service: ERP`, modal presentation, `creditnote.list.sidebar` and `creditnote.creation.sidebar`. Upload the ZIP in Sigma → extension → Configure → Upload Widget, save/install the extension, then open **Rajadhani Credit Note** under Credit Notes. Turn off Developer Mode for an installed package; local development uses `npx zet run`.

### Required organization configuration

The existing `erp_admin` connection metadata has been retained exactly. Its supplied scope list does **not** include Credit Note creation. In Zoho, add and authorize `ERP.creditnotes.CREATE`, `ERP.invoices.READ`, `ERP.contacts.READ` and `ERP.settings.READ` (and tenant permissions needed for users/salespersons and locations). Replace `usedConnections` with the newly generated connection JSON. Editing manifest scope strings cannot grant OAuth permissions.

Set actual **Credit Note custom-field IDs** in `app/config.json`. Do not reuse Invoice custom-field IDs without checking them. Populated fields without mappings block save to avoid silently losing values. Required-field choices and lookupSources remain configurable. No real tenant IDs are invented.

The existing quantity mode is `invoiceQuantityMode: "pieces"`: return quantity × Ratio is sent as ERP quantity, with rate per piece. `"order"` mode sends return quantity and rate × Ratio. The selected invoice's quantities/rates must use that same unit convention. Item packing still comes from M Unit / Ratio item-master fields.

API base defaults to India's data center. Change `apiBase` and manifest allowed domains together if using a different data center. Organization ID comes from the SDK. Session connection overrides do not persist credentials.

## Validation and limits

- `npm ci`
- `npm run build` — generates previews and runs ZET validate/pack.
- `npm test` — calculation/API unit tests and Playwright browser workflows.
- `npm run preview` — open `/dist/CreditNotePreview.html` on port 5179.

Browser tests cover matching bills, repeated item lines, source values, separate bills per item, customer changes, quantity limits, linked draft creation, API rejection/retry, ambiguous network outcomes, lookup retry and modal bounds. Fixtures are excluded from the deployable ZIP.

No live ERP organization was accessed or modified. Verify the authorized connection, custom fields, actual invoice discount representations, numbering, final totals, prior-credit limits and stock behavior in your tenant before production use. Serial/batch/bin tracked items, foreign currency and tax-inclusive source invoices require the native ERP editor. Invoice-level discounts use the native ERP editor; specialized pricing needs tenant-specific validation. Large customer histories require detail reads for every invoice; failures are surfaced and never presented as a complete empty history. Pagination fails explicitly after 100 pages.

After a confirmed save, inputs lock and the widget opens the created Credit Note. A definite API rejection permits correction and retry. An ambiguous network result disables resubmission and asks the operator to check ERP first.

## Official references reviewed

- [Widgets overview](https://www.zoho.com/erp/developer/widgets/)
- [Widget creation, validation, packing and upload](https://www.zoho.com/erp/developer/widgets/create-widget.html)
- [Manifest and connections](https://www.zoho.com/erp/developer/widgets/key-configuration.html)
- [Credit Note module and supported widget locations](https://www.zoho.com/finance/developer/widget-sdk-documentation/erp/v1/module-reference/creditnote)
- [Credit Note API: draft creation and original invoice-line references](https://www.zoho.com/erp/api/v3/credit-notes/)
- [Invoices API: transaction listing and detail](https://www.zoho.com/erp/api/v3/invoices/)

This repository is a fresh Credit Note source history. The copied Invoice/Edit Invoice packages and old Git remotes/history are not included.

## Compact green item grid

The item grid contains only Item Code, Bill No, Ref Bill No, Ref Bill Date, Pieces / pack, Order Qty, Rate, Disc %, Tax and Amount. All ten columns fit the panel without horizontal scrolling. The compact grid retains the summary on the right. Item names are available on hover over the item code. Amount remains the discounted amount before tax; quantity and per-piece rate calculations are unchanged.

## Godown and Credit Note line custom fields

Godown is required and lists all active ERP locations from every page of `/locations` (ERP manages branches/warehouses as locations). The selected ID is sent in each `line_items[].location_id`, replacing the source invoice location. For a `line_item_only` location, its parent is sent as the document location; a general location is used at both levels. Inactive locations are excluded. Failed/empty lookups do not silently choose a warehouse. Remarks is sent as `notes`. Transport, Agent and Vehicle are removed from the form/configuration.

Set `lineCustomFields.billNo.id` / `.apiName` and `lineCustomFields.billDate.id` / `.apiName` to the actual Credit Note subform identifiers. Labels are `BillNO` and `Ref_Bill Date`; the configured API names are `cf_billno` and `cf_ref_bill_date`. Each row sends `item_custom_fields` with the selected invoice number and invoice date (`YYYY-MM-DD`). A custom-field ID takes precedence over an API name. Saving is blocked while either mapping is missing; no guessed identifiers are submitted. These are line custom fields, separate from document `custom_fields`.

Godown defaults to the unique active location named **Rajadhani** (case-insensitive exact name match). Users can choose another Godown. If the default is absent or ambiguous, selection stays blank and must be made explicitly.

Bill created by, Mobile number and Shipping phone are omitted from the form and document custom-field payload. They are not required for saving. The bill-line API mappings remain `cf_billno` and `cf_ref_bill_date`.

Bill type is configured with document custom-field API name `cf_bill_type`. The widget uses a dark green theme with white section/table headings.

## Failed-save diagnostics

A failed save expands a copyable debug report below the error in the review dialog. It contains the exact approved POST payload, ERP code and complete response body/SDK envelope, selected Godown, source invoice lines, packing and custom-field mappings. Authentication keys are redacted. Reports stay in page memory; copying does not transmit them. If Zoho supplies only a generic error, the report preserves that limitation rather than inventing a field-level cause.

The numeric IDs observed in the saved native Credit Note RFCN00002 are now used in REST creation payloads: Bill type `4160832000001021023`, Bill No `4160832000001016029`, Ref Bill Date `4160832000001015013`. API names remain in configuration for reference; numeric IDs take precedence. Live creation must be retried in Zoho to confirm whether this resolves error code 6.

## Code 6 investigation — diagnostic version 2

Numeric IDs did not resolve the tenant's generic creation error, so they are not confirmed as its cause. Single-invoice returns now pass the documented `invoice_id` query parameter as well as line references, with `ignore_auto_number_generation=false`. Mixed-invoice returns retain their separate line references and do not send a misleading document-wide invoice ID. The complete query is now included in diagnostics.

After a failed save, **Inspect ERP records (read only)** collects the customer, up to five unique source invoices/items, and one existing Credit Note for the same customer (if found in the first ten). It reports lookup permission failures too; existing Credit Note access requires `ERP.creditnotes.READ`. Copy the updated report for comparison of field types, GST data, item/account/stock details and a known stored Credit Note structure. This does not retry creation or modify any records. The code 6 cause and live success remain unverified.

## Automatic Invoice Type

The widget displays Invoice Type from the selected customer's trimmed `gst_no`: **Registered** when present, **B2C others** when absent. Creation sends `reference_invoice_type` as `registered` / `b2cs` respectively. This rule is independent of shipping GSTIN and the Cash/Credit Bill type custom field. It is the requested two-way rule, not a general GST classification engine. Zoho documents the display categories in https://www.zoho.com/in/books/kb/import-export/ref-inv-type-invalid.html; the ERP REST reference omits this field, so acceptance of these wire values still requires live tenant verification. The existing generic code 6 rejection is not yet confirmed resolved.


The October 7 native draft comparison confirmed that the originally supplied line field IDs differed from the IDs returned on the saved Credit Note. Configuration now uses Bill No `4160832000001016029` and Ref Bill Date `4160832000001015013`. Bill Type remains `4160832000001021023`. This corrects the observed mapping mismatch; live creation success is still unverified.
