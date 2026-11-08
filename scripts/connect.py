"""Run AFTER deploy. Prompts privately; never writes your bot token to disk."""
import getpass
import json
import os
import secrets
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path

os.chdir(Path(__file__).resolve().parent.parent)
url = input('URL Worker (https://charging-bot....workers.dev): ').strip().rstrip('/')
if not url.startswith('https://') or not url.endswith('.workers.dev') or any(c in url for c in '?#@ '):
    sys.exit('Нужен HTTPS-адрес Worker на workers.dev без пути и параметров.')
token = getpass.getpass('BOT_TOKEN от BotFather (ввод скрыт): ').strip()
secret = secrets.token_hex(32)
if ':' not in token:
    sys.exit('Токен имеет неверный формат.')
npx = 'npx.cmd' if os.name == 'nt' else 'npx'
for name, value in [('BOT_TOKEN', token), ('WEBHOOK_SECRET', secret)]:
    subprocess.run([npx,'wrangler','secret','put',name],input=value+'\n',text=True,check=True)

def call(method, data):
    req = urllib.request.Request('https://api.telegram.org/bot'+token+'/'+method,
        data=json.dumps(data).encode(), headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=30) as response:
            result=json.load(response)
    except (urllib.error.URLError, TimeoutError):
        sys.exit('Ошибка связи с Telegram. Повтори скрипт. Токен не выводится.')
    if not result.get('ok'):
        sys.exit('Telegram отклонил запрос. Проверь токен и адрес Worker.')
    return result['result']

call('setWebhook',{'url':url+'/webhook','secret_token':secret,'max_connections':1,
                   'allowed_updates':['message','callback_query'],'drop_pending_updates':False})
call('setMyCommands',{'commands':[
    {'command':'start','description':'Помощь и мой ID'},
    {'command':'week','description':'Расписание на неделю'},
    {'command':'book','description':'Забронировать место'},
    {'command':'cancel','description':'Отменить свою бронь'},
    {'command':'today','description':'Расписание сегодня'}]})
info=call('getWebhookInfo',{})
print('Webhook установлен:',info.get('url'))
print('Ожидают обработки:',info.get('pending_update_count',0))
print('Теперь отправь боту /start. Если ответов нет — смотри раздел диагностики README.')
