"""How many conversations does GET /contacts/{id}/conversations return at once? (account 1, inbox 5, one temporary contact, deleted at the end)"""
import os, sys, uuid
INBOX = int(os.environ.get('FOYERDESK_INBOX_ID', '5'))
sys.path.insert(0, '.')
from chatwoot_api import api
s, c = api('POST', '/contacts', {'inbox_id': INBOX, 'name': 'PROBE list limit (temporary)', 'identifier': 'probe-' + uuid.uuid4().hex})
cid = c['payload']['contact']['id']; src = c['payload']['contact']['contact_inboxes'][0]['source_id']
try:
    for i in range(30):
        api('POST', '/conversations', {'inbox_id': INBOX, 'contact_id': cid, 'source_id': src, 'status': 'open', 'message': {'content': f'probe {i}', 'message_type': 'incoming'}})
    s, lst = api('GET', f'/contacts/{cid}/conversations')
    ids1 = [x['id'] for x in lst['payload']]; n = len(lst['payload']); print('created 30, one request returned', n)
    s2, page2 = api('GET', f'/contacts/{cid}/conversations?page=2')
    print('page=2 ->', s2, 'same ids as page 1:', [x['id'] for x in page2['payload']] == ids1)
    ids = [x['id'] for x in lst['payload']]; print('order newest first:', ids == sorted(ids, reverse=True), '| oldest first:', ids == sorted(ids))
    def flt(page, extra=None):
        payload = [{"attribute_key": "contact_id", "filter_operator": "equal_to", "values": [cid], "query_operator": "AND"},
                   {"attribute_key": "inbox_id", "filter_operator": "equal_to", "values": [INBOX], "query_operator": "AND" if extra else None}]
        if extra:
            payload.append(extra)
        return api('POST', f'/conversations/filter?page={page}', {"payload": payload})
    s1, p1 = flt(1); s2, p2 = flt(2); s3, p3 = flt(3)
    a, b, c3 = [x['id'] for x in p1['payload']], [x['id'] for x in p2['payload']], [x['id'] for x in p3['payload']]
    print('FILTER contact_id+inbox_id: page1', len(a), 'page2', len(b), 'page3', len(c3), '| total reported', p1['meta'].get('all_count'), '| pages disjoint:', not set(a) & set(b), '| all 30 reachable:', len(set(a + b + c3)) == 30)
    print('FILTER order newest activity first:', [x['last_activity_at'] for x in p1['payload']] == sorted([x['last_activity_at'] for x in p1['payload']], reverse=True))
    api('POST', f'/conversations/{a[0]}/toggle_status', {'status': 'resolved'})
    pl = [{"attribute_key": "contact_id", "filter_operator": "equal_to", "values": [cid], "query_operator": "AND"},
          {"attribute_key": "inbox_id", "filter_operator": "equal_to", "values": [INBOX], "query_operator": "AND"},
          {"attribute_key": "status", "filter_operator": "equal_to", "values": ["resolved"], "query_operator": None}]
    sr, pr = api('POST', '/conversations/filter?page=1', {"payload": pl})
    api('POST', f'/conversations/{a[1]}/toggle_status', {'status': 'pending'})
    api('POST', f'/conversations/{a[2]}/toggle_status', {'status': 'snoozed'})
    po = [{"attribute_key": "contact_id", "filter_operator": "equal_to", "values": [cid], "query_operator": "AND"},
          {"attribute_key": "inbox_id", "filter_operator": "equal_to", "values": [INBOX], "query_operator": "AND"},
          {"attribute_key": "status", "filter_operator": "equal_to", "values": ["open", "pending", "snoozed"], "query_operator": None}]
    so, pro = api('POST', '/conversations/filter?page=1', {"payload": po})
    print('FILTER Open tab (open+pending+snoozed): total', pro['meta'].get('all_count'), '(expect 29) | resolved excluded:', a[0] not in [x['id'] for x in pro['payload']], '| snoozed present:', a[2] in [x['id'] for x in pro['payload']] or pro['meta'].get('all_count') == 29)
    print('FILTER status=resolved:', sr, [x['id'] for x in pr['payload']] == [a[0]])
    print('items carry custom_attributes and last message:', all('custom_attributes' in x and 'messages' in x for x in p1['payload']))
finally:
    print('delete', api('DELETE', f'/contacts/{cid}')[0], api('GET', f'/contacts/{cid}')[0])
