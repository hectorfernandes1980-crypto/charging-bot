"""
Бот бронирования зарядных мест для электромобилей.

- 2 зарядных места, у каждого 2 слота в день: 9:00-14:00 и 14:00-19:00
- Бронь на неделю вперёд (по датам)
- Участники: добавляются/убираются админом
- Сброс устаревших броней автоматически

Зависимости: aiogram
Запуск: python bot.py
"""

import asyncio
import json
import os
from datetime import date, datetime, time, timedelta

from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, CallbackQuery

# ---------- Конфигурация ----------
TOKEN = os.getenv("BOT_TOKEN", "ЗАМЕНИ_НА_ТОКЕН")

# ID администратора (у кого права добавлять/убирать участников)
ADMIN_USER_ID = 209708667  # заполни своим Telegram user_id, либо бот возьмёт первого написавшего

DATA_FILE = "bookings.json"

# Слоты: (начало, конец)
SLOTS = [
    ("09:00", "14:00"),
    ("14:00", "19:00"),
]
PLACES = ["Место 1", "Место 2"]

# ---------- Хранилище ----------
class Store:
    def __init__(self):
        self.data = {
            "admin_id": ADMIN_USER_ID,
            "participants": [],  # список user_id участников
            "bookings": {},      # { "2026-11-10": { "Место 1": { "09:00-14:00": user_id, ... } } }
        }
        self.load()

    def load(self):
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE, "r", encoding="utf-8") as f:
                    self.data = json.load(f)
            except Exception:
                pass

    def save(self):
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)

    # --- участники ---
    def add_participant(self, user_id):
        if user_id not in self.data["participants"]:
            self.data["participants"].append(user_id)
            self.save()

    def remove_participant(self, user_id):
        if user_id in self.data["participants"]:
            self.data["participants"].remove(user_id)
            self.save()

    # --- брони ---
    def book(self, day: str, place: str, slot: str, user_id: int) -> str | None:
        """Возвращает None при успехе, иначе текст ошибки."""
        d = self.data["bookings"].setdefault(day, {})
        p = d.setdefault(place, {})
        if p.get(slot) is not None:
            other = p[slot]
            if other == user_id:
                return "Ты уже занял этот слот."
            return "Этот слот уже занят."
        p[slot] = user_id
        self.save()
        return None

    def cancel(self, day: str, place: str, slot: str, user_id: int) -> str | None:
        d = self.data["bookings"].get(day, {})
        p = d.get(place, {})
        if p.get(slot) == user_id:
            del p[slot]
            self.save()
            return None
        if p.get(slot) is None:
            return "Слот свободен."
        return "Слот занят не тобой."

    def cleanup(self):
        """Удаляет брони на прошедшие даты."""
        today = date.today().isoformat()
        for day in list(self.data["bookings"].keys()):
            if day < today:
                del self.data["bookings"][day]
        self.save()


store = Store()

# ---------- FSM для добавления/удаления участников ----------
class AddParticipant(StatesGroup):
    waiting_id = State()


class RemoveParticipant(StatesGroup):
    waiting_id = State()


# ---------- Вспомогательные ----------
def slot_label(slot: str) -> str:
    return slot


def is_admin(user_id: int) -> bool:
    if store.data["admin_id"] is None:
        return False
    return user_id == store.data["admin_id"]


def is_participant(user_id: int) -> bool:
    return user_id in store.data["participants"] or user_id == store.data["admin_id"]


def user_name(user_id: int) -> str:
    # имя берём из сохранённого маппинга, если есть; иначе просто id
    return store.data.get("names", {}).get(str(user_id), f"id{user_id}")


def week_days() -> list[str]:
    """Список дат: сегодня + 6 дней вперёд."""
    today = date.today()
    return [(today + timedelta(days=i)).isoformat() for i in range(7)]


def build_week_keyboard(prefix: str) -> InlineKeyboardMarkup:
    buttons = []
    for i, day in enumerate(week_days()):
        d = date.fromisoformat(day)
        label = d.strftime("%d.%m (%a)")
        buttons.append([InlineKeyboardButton(text=label, callback_data=f"{prefix}:{day}")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)


def build_slot_keyboard(day: str, action: str) -> InlineKeyboardMarkup:
    """Кнопки выбора места+слота."""
    buttons = []
    for place in PLACES:
        for slot in SLOTS:
            start, end = slot
            label = f"{place} · {start}-{end}"
            cb = f"{action}:{day}:{place}:{start}-{end}"
            buttons.append([InlineKeyboardButton(text=label, callback_data=cb)])
    buttons.append([InlineKeyboardButton(text="« Назад к датам", callback_data=f"backdays:{day}")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)


def render_day(day: str) -> str:
    d = date.fromisoformat(day)
    header = f"📅 {d.strftime('%d.%m.%Y (%A)')}"
    lines = [header]
    bookings = store.data["bookings"].get(day, {})
    for place in PLACES:
        lines.append(f"\n🔌 {place}")
        p = bookings.get(place, {})
        for slot in SLOTS:
            start, end = slot
            uid = p.get(f"{start}-{end}")
            if uid is None:
                status = "✅ свободно"
            else:
                status = f"🔴 {user_name(uid)}"
            lines.append(f"  {start}-{end}: {status}")
    return "\n".join(lines)


# ---------- Хендлеры ----------
bot = Bot(token=TOKEN)
dp = Dispatcher(storage=MemoryStorage())


@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    uid = message.from_user.id
    # если админ ещё не назначен — назначаем первого написавшего
    if store.data["admin_id"] is None:
        store.data["admin_id"] = uid
        store.save()
    store.data.setdefault("names", {})[str(uid)] = message.from_user.first_name
    store.save()

    if not is_participant(uid) and not is_admin(uid):
        await message.answer(
            "Привет! Ты пока не в списке участников. Попроси администратора добавить тебя."
        )
        return

    text = (
        "⚡ Бот бронирования зарядных мест\n\n"
        "Команды:\n"
        "/week — расписание на неделю\n"
        "/book — забронировать слот\n"
        "/cancel — освободить свой слот\n"
        "/today — свободно ли сегодня\n"
    )
    if is_admin(uid):
        text += "\n\n👑 Админ:\n/add — добавить участника\n/remove — убрать участника\n/list — список участников"
    await message.answer(text)


@dp.message(Command("today"))
async def cmd_today(message: types.Message):
    uid = message.from_user.id
    if not is_participant(uid):
        await message.answer("Ты не участник.")
        return
    day = date.today().isoformat()
    await message.answer(render_day(day))


@dp.message(Command("week"))
async def cmd_week(message: types.Message):
    uid = message.from_user.id
    if not is_participant(uid):
        await message.answer("Ты не участник.")
        return
    await message.answer("Выбери день:", reply_markup=build_week_keyboard("show"))


@dp.message(Command("book"))
async def cmd_book(message: types.Message):
    uid = message.from_user.id
    if not is_participant(uid):
        await message.answer("Ты не участник.")
        return
    await message.answer("Выбери день для брони:", reply_markup=build_week_keyboard("bookday"))


@dp.message(Command("cancel"))
async def cmd_cancel(message: types.Message):
    uid = message.from_user.id
    if not is_participant(uid):
        await message.answer("Ты не участник.")
        return
    await message.answer("Выбери день, где хочешь освободить слот:", reply_markup=build_week_keyboard("cancelday"))


# --- админские команды ---
@dp.message(Command("add"))
async def cmd_add(message: types.Message, state: FSMContext):
    if not is_admin(message.from_user.id):
        await message.answer("Нет прав.")
        return
    await message.answer("Пришли Telegram user_id человека, которого добавить (число).")
    await state.set_state(AddParticipant.waiting_id)


@dp.message(AddParticipant.waiting_id)
async def process_add_id(message: types.Message, state: FSMContext):
    try:
        uid = int(message.text.strip())
    except ValueError:
        await message.answer("Это не число. Пришли user_id цифрами.")
        return
    store.add_participant(uid)
    await state.clear()
    await message.answer(f"Добавил участника id{uid}. Теперь в списке {len(store.data['participants'])} чел.")


@dp.message(Command("remove"))
async def cmd_remove(message: types.Message, state: FSMContext):
    if not is_admin(message.from_user.id):
        await message.answer("Нет прав.")
        return
    await message.answer("Пришли Telegram user_id человека, которого убрать (число).")
    await state.set_state(RemoveParticipant.waiting_id)


@dp.message(RemoveParticipant.waiting_id)
async def process_remove_id(message: types.Message, state: FSMContext):
    try:
        uid = int(message.text.strip())
    except ValueError:
        await message.answer("Это не число. Пришли user_id цифрами.")
        return
    store.remove_participant(uid)
    await state.clear()
    await message.answer(f"Убрал участника id{uid}. Теперь в списке {len(store.data['participants'])} чел.")


@dp.message(Command("list"))
async def cmd_list(message: types.Message):
    if not is_admin(message.from_user.id):
        await message.answer("Нет прав.")
        return
    parts = []
    parts.append(f"👑 Админ: {user_name(store.data['admin_id'])} (id{store.data['admin_id']})")
    for uid in store.data["participants"]:
        parts.append(f"• {user_name(uid)} (id{uid})")
    await message.answer("\n".join(parts))


# --- callback-обработчики ---
@dp.callback_query(F.data.startswith("show:"))
async def cb_show(cb: CallbackQuery):
    day = cb.data.split(":", 1)[1]
    await cb.message.edit_text(render_day(day), reply_markup=build_week_keyboard("show"))
    await cb.answer()


@dp.callback_query(F.data.startswith("bookday:"))
async def cb_bookday(cb: CallbackQuery):
    day = cb.data.split(":", 1)[1]
    await cb.message.edit_text(f"Выбери слот на {day}:", reply_markup=build_slot_keyboard(day, "dobook"))
    await cb.answer()


@dp.callback_query(F.data.startswith("cancelday:"))
async def cb_cancelday(cb: CallbackQuery):
    day = cb.data.split(":", 1)[1]
    await cb.message.edit_text(f"Выбери свой слот на {day}:", reply_markup=build_slot_keyboard(day, "docancel"))
    await cb.answer()


@dp.callback_query(F.data.startswith("backdays:"))
async def cb_backdays(cb: CallbackQuery):
    await cb.message.edit_text("Выбери день:", reply_markup=build_week_keyboard("show"))
    await cb.answer()


@dp.callback_query(F.data.startswith("dobook:"))
async def cb_dobook(cb: CallbackQuery):
    _, day, place, slot = cb.data.split(":", 3)
    uid = cb.from_user.id
    err = store.book(day, place, slot, uid)
    if err:
        await cb.answer(err, show_alert=True)
        return
    await cb.message.edit_text(f"✅ Забронировано: {place}, {slot}, {day}\n\n{render_day(day)}",
                               reply_markup=build_week_keyboard("show"))
    await cb.answer("Забронировано!")


@dp.callback_query(F.data.startswith("docancel:"))
async def cb_docancel(cb: CallbackQuery):
    _, day, place, slot = cb.data.split(":", 3)
    uid = cb.from_user.id
    err = store.cancel(day, place, slot, uid)
    if err:
        await cb.answer(err, show_alert=True)
        return
    await cb.message.edit_text(f"🗑 Освобождён слот: {place}, {slot}, {day}\n\n{render_day(day)}",
                               reply_markup=build_week_keyboard("show"))
    await cb.answer("Освобождено")


async def cleanup_loop():
    while True:
        store.cleanup()
        await asyncio.sleep(3600)  # раз в час


async def main():
    asyncio.create_task(cleanup_loop())
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
