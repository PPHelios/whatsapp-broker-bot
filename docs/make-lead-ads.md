# Facebook/Instagram lead ads into WehdatHub through Make (turnkey)

One Make account, owned by the WehdatHub owner, serves every agency. Agencies never create accounts.

## Per agency (about 15 minutes)

1. **Agency:** in Meta Business Suite, add the owner's Facebook account to the agency's Page with **Leads** access
   (Page settings → Page access, or Business settings → Pages → assign people → Leads).
   If **Leads Access Manager** is restricted (Business settings → Integrations → Leads access), also allow **Make** as a CRM.
2. **Owner, on /app/owner → Automatic lead intake:** pick the agency, name it (e.g. "Facebook ads (Make)"),
   source **Facebook**, quiet days 3, press **New URL** and copy the URL (shown once).
3. **Owner, in Make:** clone the template scenario (below), then in the clone:
   - Facebook Lead Ads → *Watch new leads*: connection = the owner's Facebook account, Page = the agency's Page,
     Form = all forms (or one).
   - HTTP → *Make a request*: URL = the intake URL, Method POST, Body type Raw, Content type JSON,
     Request content = the JSON below.
   - Name the scenario after the agency, schedule **Immediately**, turn it on.
4. **Check:** press **🧪 Test** on /app/owner (checks the URL, saves nothing), then send one lead from Meta's
   [Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing) and check it reaches a broker
   (Telegram alert) with source Facebook or Instagram.

## Template scenario

Module 1: **Facebook Lead Ads → Watch new leads**. Module 2: **HTTP → Make a request** with this request content
(map the fields from module 1):

```json
{
  "id": "{{1.id}}",
  "platform": "{{1.platform}}",
  "campaign_name": "{{1.campaign_name}}",
  "form_name": "{{1.form_name}}",
  "ad_name": "{{1.ad_name}}",
  "full_name": "{{1.full_name}}",
  "phone_number": "{{1.phone_number}}",
  "email": "{{1.email}}"
}
```

Map each of the form's own questions the same way (`"budget": "{{1.…}}"`): fields WehdatHub knows (budget, area,
bedrooms, property type, sale or rent) fill the client's request; anything else goes into the lead's notes. Meta's raw
`field_data` array (`[{ "name": …, "values": [...] }]`) is accepted too. `id` makes Make's retries safe (the same lead is taken once). Add `"test": true` to check without saving.

## What WehdatHub does with a lead

- Source: Instagram or Facebook from `platform` (else the intake's source); the campaign goes to the notes.
- Same phone as an existing lead: merged into it, and its broker is told the client asked again.
- New lead: the next broker in turn (not away; longest without a lead first), with the agency's response rule.
- Every request is in the intake log (no phone numbers, last 4 digits only). No lead for the quiet days → one alert to
  the owner (Telegram) and the agency's managers.

## Make plan

The free plan allows 2 active scenarios, so more than 2 agencies need a paid plan (Core). Check the current price on
make.com/pricing before buying; operations per lead: 2 (trigger + HTTP).
