# Order export - order detail, columns and routes

This documents the order-detail columns added to `orders` / `order_line_items`, how they get
filled from Shopify, the daily export sheet's columns, and the new admin routes. See
`src/services/orderDetails.ts` and `src/services/orderSync.service.ts` for the full reasoning in
code comments - this file is the quick reference.

## Where the data comes from - and why it must

Our Shopify app does **not** have Protected Customer Data access approved (Settings → the app →
Configuration → API access, in the Shopify admin). Confirmed empirically: a live REST or GraphQL
read of an order comes back with `shipping_address`/`billing_address` reduced to
`province`/`country` only, `customer.email`/`phone` and `order.email`/`phone` entirely absent, and
GraphQL refusing those fields outright with `ACCESS_DENIED`.

The **raw webhook payload** (`req.shopifyPayload`) is not subject to this restriction - it carries
the real address lines, city, zip, phone and customer email/name. So every address/customer field
is read **only** from the webhook body, in `services/orderDetails.ts`, and that file is never
called with a value from a live Shopify API read. Everything else (totals, tax, discount, payment
method, note, tags, cancel reason, ship/deliver dates, line-item variant/discount/tax) is **not**
PII-gated - confirmed present on a live read too - so it lives in the shared, source-agnostic
`orderFieldsFromShopify` / `lineItemsFromShopify` in `services/orderSync.service.ts`, used by the
webhooks, the fulfillment-webhook REST remirror, the admin mark-paid/fulfilled actions, and the
(currently disabled) reconciler alike.

If Protected Customer Data access is granted later, nothing here needs to change - the webhook
payload will simply stop being redacted and the same code will start filling the address/customer
columns for every order.

## `orders` - new columns

| Column | Source | Notes |
|---|---|---|
| `order_number` | webhook or REST | Shopify's `#1023` display number |
| `shipping_name` / `shipping_address1` / `shipping_address2` / `shipping_city` / `shipping_state` / `shipping_zip` / `shipping_country` / `shipping_phone` | **webhook only** | |
| `billing_name` / `billing_address1` / `billing_address2` / `billing_city` / `billing_state` / `billing_zip` / `billing_country` / `billing_phone` | **webhook only** | Has been `NULL` for every order seen so far - this store's checkout does not appear to collect a separate billing address, not a redaction artifact (confirmed: webhook payloads also carry it as `null`). |
| `customer_email` / `customer_phone` | **webhook only** | Shopify's own order/customer contact - distinct from `email`/`phone`, which are the **employee's** identity set by create-order's `note_attributes`, not Shopify's customer object. |
| `subtotal_price` / `total_discount` / `total_tax` / `shipping_charge` / `payment_method` | webhook or REST | `shipping_charge` is the sum of `shipping_lines[].price` (Shopify has no single field for it). |
| `order_note` / `tags` | webhook or REST | |
| `cancel_reason` / `cancelled_at` | webhook or REST | |
| `shipped_at` | webhook or REST | Earliest non-cancelled fulfillment's `created_at`. |
| `delivered_at` | webhook or REST | `updated_at` of the fulfillment whose `shipment_status` is `delivered`. Shopify has no dedicated "delivered at" field; this is the best approximation available without subscribing to `fulfillment_events/create` (not currently a registered webhook). |
| `raw_payload` | webhook only | **Not a Sequelize model attribute** - written/read only via raw SQL in `orderSync.service.ts` / `orderBackfill.service.ts`, so it can never leak through `order.toJSON()` into any API response. Backend-only, for recovering a field later without re-asking Shopify. |

`order_line_items` gained `variant_title`, `line_discount` (sum of `discount_allocations`),
`line_tax` (sum of `tax_lines`).

## Webhook handlers (`src/controllers/webhook.controller.ts`)

`orderCreate`, `orderUpdated`, `orderPaid`, `orderCancelled` and `orderFulfilled` now all go
through one shared path (`ingestOrderPayload` → `orderSync.service.ts`'s `upsertOrderFromWebhook`):
**upsert** the order by `shopify_order_id` (create it if MAP has never seen this order - covers a
webhook arriving before, or instead of, create-order's own insert), replace its line items, and
write `raw_payload`. This is a behaviour change from before: `orderUpdated` used to silently skip
an order it didn't already know about; now it creates it, same as `orderCreate`.

A field the payload does not carry is left as `undefined` and never overwrites what's already
stored - the same "missing stays missing" rule the original `orders/updated` handler used.

The `console.log(payload, 'payload')` that used to print every `orders/create` body in full
(including customer PII) has been removed.

`fulfillmentCreate`/`fulfillmentUpdate` are unchanged in shape: they set tracking from the
fulfillment object, then re-read the order live from Shopify (REST - PII-safe fields only) and
mirror it.

## Backfill (`npm run backfill:order-details`)

For orders that predate these columns, this looks for a previously-logged webhook payload
(`webhook_logs`, keyed by the payload's own `id`) and replays the exact same mapping against it -
never calls Shopify, never invents data. Current result on this database: 81 orders had no detail
yet; 30 had a logged payload and were backfilled; 51 have no log at all (older than when webhook
logging started) and stay blank.

## Export sheet (`services/orderExport.service.ts`)

Real `.xlsx` (not CSV) - sheet name `Orders`. Bold header row on a light grey fill, frozen, with
an autofilter over the full header; `₹#,##0.00` number format on Unit Price/Total Price; the
Address column wraps text at width 60; every other column auto-sized to its content.
`DD-MM-YYYY HH:mm` (or `DD-MM-YYYY` for Export Date) rendered in IST regardless of the server's
own timezone (`formatIST`/`formatDateOnly` - unrelated to the `dayBounds()` caveat below). No
Shopify API call happens anywhere in this file - it only reads `orders`/`order_line_items`/`users`.

**12 columns**, in this order: **Id** (`orderNumber`, falling back to `shopifyOrderId`) · **Name**
(`orders.name`, falling back to the `users` row looked up by `orders.email`) · **Email**
(`orders.email`) · **Export Date** (the day this sheet covers, not the order's own date - constant
for every row) · **Product SKU** · **Product Name** (`title`, plus `" - " + variantTitle` when
there is one) · **Unit Price** · **Quantity** · **Total Price** (`Unit Price × Quantity` - the
*line's* total, not the order's) · **Address** (`address1, address2, city, state, zip, country`
comma-joined, empty parts skipped - a plain string, so Excel never auto-detects the PIN as a
number) · **Created At** · **Updated At**.

One row per line item; Id/Name/Email/Export Date/Address/Created At/Updated At repeat across an
order's rows. Rows are ordered oldest-`Created At`-first, then by Id, then by each order's own
line-item order - regardless of how the DB was queried. A trailing **bold `Total` row** sums
Quantity and Total Price (`Total | | | | | | | 3 | ₹897.00 | | |` - everything else blank).

**Cancelled orders are excluded everywhere this builder is used**: `cancelledAt` set, `status`
`cancelled`, or `financialStatus` `voided`/`refunded` (`isExcludedOrder`, exported for reuse by
`runDailyExport.ts`'s `--dry-run`). The employee-wise daily export writes nothing - no file or
`DailyExport` row - for an employee/day with zero qualifying orders. Consolidated generation is
disabled; existing historical consolidated records/files are retained for preview/download. The
on-demand "Export My Orders" button (`generateDailyExport`, all-time, not
day-scoped) still always writes a file, since a user-initiated download expects an immediate
result; it uses the same 12 columns and exclusion rule, but keeps its original
`sap-orders-<email>-<date>.csv`-style filename (now `.xlsx`) rather than the new
`<exportDate>_<employeeId>` convention, which was asked for the daily cron/admin sheets specifically.

File names: per-employee `<exportDate>_<employeeId>.xlsx` (falls back to an email slug on the
rare order whose email matches no `users` row). New cron workbooks are uploaded directly to
Cloudinary as private raw files and are not permanently written to `exports/daily` or
`exports/daily/all`. Existing local historical files remain readable.

Cloudinary export storage requires `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and
`CLOUDINARY_API_SECRET`. The database stores the Cloudinary public ID, raw/private resource
metadata, filename, export date, employee ID, and employee email. Employee view/download routes
verify ownership before proxying the private file; admin routes retain their existing permissions.
If an upload or database write fails, the employee export is reported as failed and no successful
`DailyExport` record is created. The unique employee/date index handles overlapping cron runs.

**Columns always blank today, and why**: Address for any order placed before Protected Customer
Data access is granted *and* whose checkout never collected it (see the section above); Name
only when neither `orders.name` nor a matching `users` row has one.

Old `.csv` / 48-column `.xlsx` exports already on disk keep working - `GET /api/sap/daily-exports/:id/view`
branches on the file extension; `.xlsx` is read with ExcelJS's xlsx reader, `.csv` with its
original csv reader. They are not retroactively rewritten to the new 12-column format.

### Cron and manual trigger

The cron (`src/jobs/employeeDailyExportCron.ts`) runs at `5 0 * * *` with node-cron's own
`timezone: 'Asia/Kolkata'` option, so it fires at 00:05 IST regardless of the server's own
timezone. The previous date and the database range boundaries are also calculated explicitly in
IST, so the target is always the previous completed IST calendar day.

`npm run export:daily -- [--date=YYYY-MM-DD] [--force] [--dry-run]` runs the exact same logic
on demand, for one explicit day (defaults to yesterday):
- `--force` deletes any existing record (and its file) for that date first, then regenerates -
  a normal run always skips a date it already has.
- `--dry-run` computes and prints what would happen - how many files would be created, how many
  employees already have a record, how many have no qualifying order, and excluded counts by
  cancelled/voided/refunded reason - without writing anything.

The workbook contract is exactly 12 columns, one row per line item, with order number (never the
database primary key) in `Id`, IST date/timestamp formatting, text-preserved PINs in the wrapped
Address column, numeric line totals, and a final bold `Total` row. Use
`npx tsx --test test/orderExport.test.ts` for the ExcelJS workbook verification tests.

## Routes

New, under `/api/admin` (so `authenticate` + `requireAdmin` already ran - see `app.ts`):

- `GET /api/admin/orders/today` - today's orders straight from the DB (rows, count, total value).
- `GET /api/admin/daily-exports?from=&to=&limit=&after=&before=` - historical consolidated export
  records only; no new consolidated files or records are generated. Uses this app's existing cursor pagination (`after`/`before`), not `?page=` -
  every other list endpoint in this app already uses that contract (see `utils/paginate.ts`'s own
  comment: "There is no `?page=` any more"), so this stays consistent with them instead of
  introducing a second convention.
- `GET /api/admin/daily-exports/:id` - preserves inline preview (columns + rows) for historical
  consolidated files.
- `GET /api/admin/daily-exports/:id/download` - preserves historical `.xlsx` downloads.

`/api/sap/daily-exports` (the employee's own export history) is untouched.

**On the 403 asked for**: a non-admin JWT on any `/api/admin/*` route - these new ones included -
gets **404** "Route not found", not 403. That is this project's existing, deliberate, documented
behaviour (`middleware/requireAdmin.ts`: "the admin routes simply do not exist for this caller - no
403 in the client contract"), applied here for consistency with every other admin route rather than
introduced as a one-off exception.

## Historical verification notes (2026-10-09, before consolidated generation was disabled)

The operational verification notes below describe the older export behavior and are retained only
as historical context. Current verification is covered by `test/orderExport.test.ts`; it asserts
employee-only generation and does not create `exports/daily/all`.

- Placed a real two-SKU order (qty 2 + qty 1, both ₹299) through `POST /api/map/create-order` →
  landed in the per-employee sheet as exactly 2 rows under the same Id, Quantity 2 and 1, Total
  Price ₹598 and ₹299 - summing to Quantity 3 / ₹897 across just those two rows.
- A second, separate order for the same employee the same day → its row appears in the same file
  as every other order of theirs that day.
- A real cancelled order (`cancelledAt` set) placed earlier → confirmed absent from both the
  per-employee and admin-all sheets for that day.
- Address cell: empty `address2`/name/phone skipped, PIN embedded as plain text inside the joined
  string (never auto-converted to a number).
- `npm run export:daily -- --date=2026-10-09 --dry-run` → "would create 1 file(s), 0 already have
  a record, 10216 have no non-cancelled order, 1 order(s) excluded" (of 10217 employees), with
  nothing written. The real run then created exactly that 1 file.
- Generated `.xlsx` inspected directly: 12-column header, bold + light-grey + frozen + autofiltered,
  ₹ number format, rows in ascending `Created At` order, bold `Total` row with the correct summed
  Quantity/Total Price and every other cell blank.
- `GET /api/admin/daily-exports` → `200`, the admin all-orders row for the day; `GET
  /api/admin/daily-exports/:id` → the same 12 columns and a correct `Total` row across every
  employee's orders that day.
- `npm run backfill:order-details` → 81 candidates, 30 backfilled from logged payloads, 51 left
  blank (no log to backfill from) - unaffected by this change.
- Admin token on the admin routes → 200. Employee token on the same routes → 404 (see above).
