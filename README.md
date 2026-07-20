# LangerMail Lite

A superlightweight **transactional email sender driven entirely from HubSpot**.
A HubSpot workflow enrolls a contact, a **custom code action** reads a
**Transactional Email** custom object, resolves its HTML, strips the footer,
substitutes `{{merge_tags}}` from the contact, and sends via **AWS SES**.

No web app, no email builder, no servers. The email HTML is an explicit input
on the object — nothing is scraped or "extracted."

**Design A** (chosen): SES is called directly from the HubSpot code step. The
action ([`hubspot/custom-code-action.js`](hubspot/custom-code-action.js)) has
**zero external dependencies** — it signs SES requests itself (SigV4 via Node's
built-in `crypto`) and uses the global `fetch`, so it can't break on the code
step's package allowlist.

```
Transactional Email object ──▶ Workflow ──▶ Custom Code Action ──▶ AWS SES
  subject / from / html            (per contact)   fetch → strip footer
                                                    → merge tags → send
```

## Repo layout

| Path | What |
|---|---|
| `hubspot/custom-code-action.js` | **The deliverable.** Paste into the workflow custom code action. |
| `test/render.test.js` | Unit tests for merge-tag + footer + payload logic (`npm test`). |
| `scripts/send-test.js` | Local SES smoke test — prove the AWS half before touching HubSpot. |
| `docs/HTML_AUTHORING.md` | Conventions for whoever writes the email HTML. |

## Quick start

### 0. Verify the SES half locally (recommended first step)

Proves your AWS credentials + region + verified domain work, independent of
HubSpot:

```bash
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
FROM_EMAIL=noreply@mail.langerlabs.com TO_EMAIL=you@example.com \
npm run send-test
```

A `Sent. SES MessageId: ...` line means signing + delivery work. (Set
`AWS_REGION` to whatever region `mail.langerlabs.com` is verified in — confirm
in the SES console.)

### 1. Create the "Transactional Email" custom object

Settings → Objects → Custom Objects (or the Schemas API). Properties:

| Property | Type | Purpose |
|---|---|---|
| `name` | text (primary label) | Human name of the email |
| `subject` | text | Subject line (may contain `{{tokens}}`) |
| `from_name` | text | Display name, optional |
| `from_email` | text | Sender, e.g. `noreply@mail.langerlabs.com` |
| `reply_to` | text | Optional Reply-To |
| `html` | multi-line text | Raw HTML *(option 1)* |
| `html_file_id` | text | Files file id or URL *(option 2)* |

You can use either `html` or `html_file_id`; if both are set, `html` wins. See
[`docs/HTML_AUTHORING.md`](docs/HTML_AUTHORING.md). To change property names,
edit the `PROPS` map at the top of the action file.

### 2. Create a Private App for the token

Settings → Integrations → Private Apps. Scopes:

- `crm.objects.custom.read` — read the Transactional Email record
- `crm.objects.contacts.read`
- `files` — read the HTML file (only needed if you use `html_file_id`)

Copy the access token; you'll store it as the `HUBSPOT_TOKEN` secret.

### 3. Build the workflow + custom code action

1. Create a **contact-based workflow** that enrolls your target contacts.
2. Add a **Custom code** action (Operations Hub Pro/Enterprise), language
   **Node.js**.
3. **Secrets** (add each in the action's Secrets panel):

   | Secret | Value |
   |---|---|
   | `HUBSPOT_TOKEN` | private-app access token from step 2 |
   | `AWS_ACCESS_KEY_ID` | SES sender IAM key id |
   | `AWS_SECRET_ACCESS_KEY` | SES sender IAM secret |
   | `AWS_REGION` | SES region, e.g. `us-east-1` |
   | `TRANSACTIONAL_EMAIL_OBJECT_TYPE` | object type — FQN (`p12345_transactional_email`) or id (`2-1234567`) |
   | `SES_CONFIGURATION_SET` | *(optional)* for open/click/bounce tracking |

4. **Input fields** (Property to include in code):

   | Input | Map to | Required |
   |---|---|---|
   | `transactional_email_id` | the Transactional Email record id | ✅ |
   | `email` | `contact.email` (the recipient) | ✅ |
   | `firstname`, `company`, … | any contact property you want as a `{{token}}` | optional |

   Any input field other than `transactional_email_id` / `email` /
   `hs_object_id` becomes an available merge token by its input name.

5. Paste the contents of `hubspot/custom-code-action.js` into the code editor.
6. **Output fields** (optional, for branching/logging): `status`, `messageId`,
   `error`.

### 4. How the id gets to the action

The action needs the Transactional Email record id in `transactional_email_id`.
Options:
- Store the id in a contact property the workflow maps as the input, or
- Hardcode a per-workflow default in a "Set property value" step, or
- Use an association + a small lookup (extend the action if you need this).

## AWS / SES

Reuses existing production SES infra:

- Verified domain **`mail.langerlabs.com`** (DKIM done), out of the sandbox.
- IAM user needs:
  `{"Effect":"Allow","Action":["ses:SendEmail","ses:SendRawEmail"],"Resource":"*"}`
- Region: whatever `mail.langerlabs.com` is verified in — confirm in the SES
  console and set `AWS_REGION` to match.

Credentials are **secrets** on the code action — never hardcoded.

## Development

```bash
npm test          # run the unit tests (Node's built-in test runner, no deps)
npm run send-test # live SES smoke test (needs AWS env vars — see above)
```

The pure logic (`mergeTags`, `stripFooter`, `buildEmailPayload`,
`tokensFromInputs`) is exported from the action file and covered by tests. The
same `buildEmailPayload` / `sesSendEmail` used in production back the smoke
test, so there is no test/prod drift.

## Definition of done

A contact enrolled in the workflow, with a Transactional Email record referenced
by `transactional_email_id`, receives that record's HTML — footer stripped,
`{{tokens}}` filled from their contact data — delivered from
`mail.langerlabs.com` via SES.
