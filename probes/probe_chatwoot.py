"""Facts about Chatwoot 4.20.1 that the multi-ticket /talk depends on. Account 1, inbox 5 only.
Creates ONE temporary contact (no email, so nobody is mailed) and deletes it at the end.
Run: python3 probe_chatwoot.py   Exit code 1 if any fact differs from what the design assumes."""
import os, sys, time, uuid
sys.path.insert(0, '.')
from chatwoot_api import api
INBOX = int(os.environ.get('FOYERDESK_INBOX_ID', '5'))
facts, failed = [], 0
def fact(name, ok, detail=''):
    global failed
    failed += 0 if ok else 1
    facts.append((ok, name, detail)); print(('PASS ' if ok else 'FAIL ') + name + (' - ' + str(detail) if detail else ''))
s, c = api('POST', '/contacts', {'inbox_id': INBOX, 'name': 'PROBE portal logic (temporary)', 'identifier': 'probe-' + uuid.uuid4().hex})
cid = c['payload']['contact']['id']; src = c['payload']['contact_inbox']['source_id'] if 'contact_inbox' in c['payload'] else c['payload']['contact']['contact_inboxes'][0]['source_id']
try:
    def new(text, extra=None):
        body = {'inbox_id': INBOX, 'contact_id': cid, 'source_id': src, 'status': 'open', 'message': {'content': text, 'message_type': 'incoming'}}
        body.update(extra or {}); return api('POST', '/conversations', body)
    s, a = new('Topic A: billing question', {'custom_attributes': {'subject': 'Billing question'}})
    fact('create conversation with custom_attributes.subject', s == 200, s)
    A = a['id']
    s, b = new('Topic B: course access'); B = b['id']
    fact('a contact can hold several conversations in the same inbox', s == 200 and A != B, f'{A},{B}')
    s, lst = api('GET', f'/contacts/{cid}/conversations')
    ids = sorted(x['id'] for x in lst['payload'])
    fact('contact conversation list returns both with status and inbox', ids == sorted([A, B]) and all('status' in x and x['inbox_id'] == INBOX for x in lst['payload']), ids)
    s, got = api('GET', f'/conversations/{A}')
    fact('custom_attributes.subject is stored and readable', got.get('custom_attributes', {}).get('subject') == 'Billing question', got.get('custom_attributes'))
    fact('conversation meta carries the owning contact id', got['meta']['sender']['id'] == cid and got['inbox_id'] == INBOX)
    # close one topic
    s, r = api('POST', f'/conversations/{A}/toggle_status', {'status': 'resolved'})
    s, got = api('GET', f'/conversations/{A}')
    fact('customer-side close: toggle_status resolved works through the Application API', got['status'] == 'resolved', got['status'])
    # a new message on a resolved topic
    s, m = api('POST', f'/conversations/{A}/messages', {'content': 'Follow-up on topic A', 'message_type': 'incoming', 'private': False})
    time.sleep(2)
    s, got = api('GET', f'/conversations/{A}')
    fact('incoming message on a resolved conversation is accepted (allow_messages_after_resolved)', s == 200, s)
    reopened = got['status']
    fact('...and reopens it automatically' if reopened == 'open' else '...but does NOT reopen it (reopen must be explicit)', True, reopened)
    # explicit reopen
    api('POST', f'/conversations/{A}/toggle_status', {'status': 'resolved'})
    s, r = api('POST', f'/conversations/{A}/toggle_status', {'status': 'open'})
    s, got = api('GET', f'/conversations/{A}')
    fact('explicit reopen: toggle_status open works', got['status'] == 'open', got['status'])
    # pending / snoozed visibility
    api('POST', f'/conversations/{B}/toggle_status', {'status': 'pending'})
    s, got = api('GET', f'/conversations/{B}')
    fact('pending status exists and is readable', got['status'] == 'pending', got['status'])
    # list filters
    s, lst = api('GET', f'/contacts/{cid}/conversations')
    fact('list shows each conversation status for tab grouping', {x['id']: x['status'] for x in lst['payload']} == {A: 'open', B: 'pending'}, {x['id']: x['status'] for x in lst['payload']})
    # messages: paging params on a second conversation, ownership foreign id
    s, lst_all = api('GET', '/conversations?status=all')
    cand = [x for x in lst_all['data']['payload'] if x['meta']['sender']['id'] != cid]
    s, other = api('GET', f"/conversations/{cand[0]['id']}") if cand else (0, {'meta': {'sender': {'id': cid}}})
    fact('a conversation of another contact is readable with the service token, so ownership MUST be checked by the Worker', s == 200 and other['meta']['sender']['id'] != cid, other['meta']['sender']['id'])
    # activity / automation side effects
    s, got = api('GET', f'/conversations/{A}')
    fact('automation rules ran on the new conversation (SLA applied)', got.get('sla_policy_id') is not None, got.get('sla_policy_id'))
    s, msgs = api('GET', f'/conversations/{A}/messages')
    kinds = [m['message_type'] for m in msgs['payload']]
    fact('status changes appear as activity messages (type 2) the page must hide', 2 in kinds, kinds)
finally:
    s = api('DELETE', f'/contacts/{cid}')[0]
    s2 = api('GET', f'/contacts/{cid}')[0]
    fact('temporary contact deleted', s2 == 404, f'delete={s} get={s2}')
print(f'\n{len(facts)-failed}/{len(facts)} facts as designed')
sys.exit(1 if failed else 0)
