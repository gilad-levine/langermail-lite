# LangerMail Lite

A superlightweight **transactional email sender driven entirely from HubSpot**.
A HubSpot workflow enrolls a contact, a **custom code action** reads a
**Transactional Email** custom object, resolves its HTML, strips the footer,
substitutes `{{merge_tags}}` from the contact, and sends via **AWS SES**.

No web app, no email builder, no servers. The email HTML is an explicit input
on the object — nothing is scraped or "extracted."

**Design A** (chosen + validated live): SES is called directly from the HubSpot
code step. The action
([`hubspot/custom-code-action.js`](hubspot/custom-code-action.js)) has **zero
external dependencies** — Node's built-in `https` + `crypto` only (it signs SES
requests itself via SigV4), so it runs on any code-step runtime and can't break
on the package allowlist.

```
Transactional Email object ──▶ Workflow ──▶ Custom Code Action ──▶ AWS SES
  subject / from / html            (per contact)   fetch → strip footer
                                                    → merge tags → send
```

## Status

End-to-end send is **working and verified** from the HubSpot code step against
production SES (`mail.langerlabs.com`). Remaining polish is template-authoring
(absolute image URLs, footer markers) — see [Authoring](#authoring-the-email-html).

## Repo layout

| Path | What |
|---|---|
| `hubspot/custom-code-action.js` | **The deliverable.** Paste into the workflow custom code action. |
| `test/render.test.js` | Unit tests for merge-tag + footer + payload logic (`npm test`). |
| `scripts/ses-smoke.js` | Local SES smoke test — prove the AWS half before touching HubSpot. |
| `docs/HTML_AUTHORING.md` | Conventions for whoever writes the email HTML. |

## The Transactional Email object

Object type `2-66209712`. Properties the action reads (override the `PROPS` map
at the top of the action if these change):

| Property | Type | Purpose |
|---|---|---|
| `subject_line` | single-line text | Subject (may contain `{{tokens}}`) |
| `from_name` | dropdown | Sender display name |
| `from_address` | dropdown | Sender, e.g. `test@mail.langerlabs.com` |
| `replyto_address` | dropdown | Reply-To |
| `body_html_file` | file upload | **Preferred** — the raw HTML file |
| `body_html_text` | rich text | Fallback — see the warning below |

> **Prefer the file.** The rich-text property **escapes raw HTML source** if you
> paste a full template into it, so the recipient sees the tags as text. The
> uploaded file holds true HTML and is tried first; rich text is only a fallback
> for simple snippets.

## Setup

### 0. Verify the SES half locally (optional but recommended)

Proves your AWS credentials + region + verified domain independent of HubSpot:

```bash
AWS_ACCESS_KEY_ID=AKIA... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
FROM_EMAIL=test@mail.langerlabs.com TO_EMAIL=you@example.com \
npm run send-test
```

A `Sent. SES MessageId: ...` line means signing + delivery work.

> The **access key id** is ~20 chars, uppercase, starts `AKIA`. The **secret**
> is ~40 chars, mixed-case, may contain `/` or `+`. Don't swap them — a `/` in
> the key-id field produces a SES "Credential must have exactly 5 ... elements"
> 403.

### 1. Private app token

Settings → Integrations → Private Apps. Scopes:

- `crm.objects.custom.read` — read the Transactional Email record
- `crm.objects.contacts.read`
- `files` — **required**: `body_html_file` is a private attachment, fetched via
  the Files API *signed-url* endpoint

Store the token as the code-action secret named **`legacyApp`**.

### 2. Workflow + custom code action

1. Contact-based workflow that enrolls your target contacts.
2. Add a **Custom code** action (Node.js). Paste `hubspot/custom-code-action.js`.
3. **Secrets:**

   | Secret | Value |
   |---|---|
   | `legacyApp` | HubSpot private-app token from step 1 |
   | `AWS_ACCESS_KEY_ID` | SES sender IAM key id (`AKIA...`) |
   | `AWS_SECRET_ACCESS_KEY` | SES sender IAM secret |
   | `AWS_REGION` | SES region, e.g. `us-east-1` |
   | `TRANSACTIONAL_EMAIL_OBJECT_TYPE` | *(optional)* defaults to `2-66209712` |
   | `SES_CONFIGURATION_SET` | *(optional)* open/click/bounce tracking |

4. **Input fields:**

   | Input | Map to | Required |
   |---|---|---|
   | `transactional_email_id` | the Transactional Email record id | ✅ |
   | `email` | `contact.email` (the recipient) | ✅ |
   | `firstname`, `company`, … | any contact property you want as a `{{token}}` | optional |

   Any input other than `transactional_email_id` / `email` / `hs_object_id`
   becomes a merge token under its input name.

5. **Output fields** (optional, for branching/logging): `status`, `messageId`,
   `error`.

### Getting the template id into the action

`transactional_email_id` must reach the code step. Options:
- store the id in a contact property mapped as the input, or
- a "Set property value" step per workflow, or
- an association + lookup (extend the action if you need this).

## Authoring the email HTML

See [`docs/HTML_AUTHORING.md`](docs/HTML_AUTHORING.md). Two gotchas we hit:

- **Upload real source HTML, not a browser "Save As".** A "Save page as" export
  has **relative** image paths (`./x_files/img.png`) that don't load in email,
  plus browser-extension junk. Use HubSpot's **Export/Copy HTML** (absolute
  `https://` CDN image URLs).
- **Footer stripping is opt-in.** `stripFooter` only removes content wrapped in
  `<!--FOOTER_START-->…<!--FOOTER_END-->` markers. Without markers the footer
  (incl. the CAN-SPAM unsubscribe + address) sends as-is — which is usually what
  you want.

## AWS / SES

Reuses existing production SES infra: verified domain `mail.langerlabs.com`
(DKIM done), out of the sandbox. IAM user needs
`{"Effect":"Allow","Action":["ses:SendEmail","ses:SendRawEmail"],"Resource":"*"}`.
Set `AWS_REGION` to whatever region the domain is verified in. Credentials are
**secrets** — never hardcoded.

## Development

```bash
npm test          # unit tests (Node's built-in runner, no deps)
npm run send-test # live SES smoke test (needs AWS env vars — see above)
```

The pure logic (`mergeTags`, `stripFooter`, `buildEmailPayload`,
`tokensFromInputs`) is exported from the action file and covered by tests. The
smoke test reuses the same `buildEmailPayload` / `sesSendEmail` as production, so
there's no test/prod drift.

## Definition of done

A contact enrolled in the workflow, with a Transactional Email record referenced
by `transactional_email_id`, receives that record's HTML — footer stripped (if
marked), `{{tokens}}` filled from their contact data — delivered from
`mail.langerlabs.com` via SES. ✅ **Achieved.**
