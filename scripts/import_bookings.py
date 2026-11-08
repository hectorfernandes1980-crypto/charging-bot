"""Convert old bookings.json to SQL; does not connect to any service."""
import json
import sys
from pathlib import Path
from datetime import date

def quote(s):
    return "'"+str(s).replace("'","''")+"'"

def convert(data):
    out=['-- Import into an EMPTY, initialized D1 database.']
    names=data.get('names',{})
    participants=set(data.get('participants',[]))
    ids=participants | {int(k) for k in names}
    if data.get('admin_id') is not None:
        ids.add(int(data['admin_id']))
    for uid in sorted(ids):
        if not isinstance(uid,int) or uid <= 0:
            raise ValueError('Invalid user ID')
        out.append(f"INSERT INTO users(user_id,name,participant) VALUES ({uid},{quote(names.get(str(uid),''))},{int(uid in participants)}) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,participant=excluded.participant;")
    for day,places in data.get('bookings',{}).items():
        if date.fromisoformat(day).isoformat()!=day:
            raise ValueError('Invalid date')
        for place,slots in places.items():
            p={'Место 1':1,'Место 2':2}[place]
            for slot,uid in slots.items():
                s={'09:00-14:00':0,'14:00-19:00':1}[slot]
                if not isinstance(uid,int) or uid <= 0:
                    raise ValueError('Invalid booking user ID')
                out.append(f'INSERT INTO bookings(day,place,slot,user_id) VALUES ({quote(day)},{p},{s},{uid});')
    return '\n'.join(out)+'\n'

if __name__ == '__main__':
    if len(sys.argv)!=3:
        sys.exit('Usage: python3 scripts/import_bookings.py bookings.json import.sql')
    data=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    result=convert(data)
    Path(sys.argv[2]).write_text(result,encoding='utf-8')
    print('SQL создан. Проверь ADMIN_USER_ID в wrangler.jsonc: в старом файле он равен',data.get('admin_id'))
