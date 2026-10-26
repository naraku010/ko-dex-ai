"""1년치 데모 데이터를 만든다.

같은 씨앗과 같은 종료일이면 항상 같은 데이터가 나온다. 데이터는 SQLite 파일 하나에 담고,
채널은 그 파일을 읽기 전용으로 조회한다.

만드는 것:
  - 판매: 날짜 × 제품 × 판매경로. 계절성, 요일, 급여일, 행사 할인, 신제품 출시 반영
  - 재고: 일별 기말 재고와 입출고. 발주는 안전재고 기준이고, 납품이 늦으면 품절이 난다
  - 소셜: 인스타그램·유튜브·틱톡·네이버블로그 게시물. 광고비와 반응, 간혹 바이럴
  - 캠페인: 기간·예산·할인율. 캠페인 기간에는 소셜 노출과 판매가 함께 뛴다

소셜을 먼저 만들고 그 클릭을 다음 며칠의 수요에 반영하기 때문에, "소셜 반응이 매출로 이어진다"는
관계가 데이터 안에 실제로 들어 있다.
"""

from __future__ import annotations

import json
import math
import random
import sqlite3
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from .catalog import APPAREL, FOOD, PRODUCTS, Product

SEED = 20260907
DAYS = 365
SCHEMA_VERSION = 1

PLATFORMS = ("인스타그램", "유튜브", "틱톡", "네이버블로그")
SALES_CHANNELS = ("온라인몰", "모바일앱", "오프라인매장")
CHANNEL_MIX = {APPAREL: (0.44, 0.41, 0.15), FOOD: (0.38, 0.33, 0.29)}

# 명절 선물세트 수요가 몰리는 날. 데이터 기간이 옮겨져도 쓰이도록 여러 해를 담아둔다.
HOLIDAYS = (
    (date(2025, 1, 29), "설날"),
    (date(2025, 10, 6), "추석"),
    (date(2026, 2, 17), "설날"),
    (date(2026, 9, 25), "추석"),
    (date(2027, 2, 6), "설날"),
    (date(2027, 9, 15), "추석"),
)

WEEKDAY = {
    APPAREL: (0.85, 0.90, 0.95, 1.00, 1.12, 1.28, 1.20),  # 월~일
    FOOD: (0.95, 0.95, 0.98, 1.02, 1.10, 1.15, 1.08),
}


def _gift_factor(day: date) -> float:
    """명절 전 3~4주에 몰리고 연휴 직후 급락하는 선물세트 수요."""
    for holiday, _ in HOLIDAYS:
        delta = (holiday - day).days
        if 0 <= delta <= 26:
            # 연휴 6~8일 전이 정점
            return 0.5 + 8.5 * math.exp(-((delta - 7) ** 2) / 60)
        if -4 <= delta < 0:
            return 0.25
    return 0.35


# 캠페인 일정. 이름과 시기가 어긋나면 데모가 어색해지니 달력에 붙여서 잡는다.
#   ("md", 월, 일)      해당 날짜에 시작
#   ("holiday", 이름, N) 그 명절 N일 전에 시작
CAMPAIGN_PLANS = (
    ("가을 신상 프리뷰", APPAREL, "브랜드", 0.05, ("md", 9, 10), 10),
    ("추석 선물세트 사전예약", FOOD, "매출", 0.08, ("holiday", "추석", 24), 14),
    ("겨울 아우터 얼리버드", APPAREL, "매출", 0.15, ("md", 10, 20), 10),
    ("김장 시즌 기획전", FOOD, "매출", 0.12, ("md", 11, 5), 12),
    ("블랙프라이데이 위크", APPAREL, "매출", 0.25, ("md", 11, 24), 7),
    ("연말 홈파티 식품전", FOOD, "매출", 0.15, ("md", 12, 15), 12),
    ("신년 아우터 클리어런스", APPAREL, "재고소진", 0.30, ("md", 1, 2), 12),
    ("설 선물세트 본판매", FOOD, "매출", 0.08, ("holiday", "설날", 21), 14),
    ("봄 간절기 룩북", APPAREL, "브랜드", 0.05, ("md", 3, 10), 10),
    ("봄나들이 간편식 기획전", FOOD, "매출", 0.12, ("md", 4, 15), 10),
    ("여름 준비 티셔츠 1+1", APPAREL, "매출", 0.20, ("md", 5, 20), 9),
    ("여름 음료 시원한 딜", FOOD, "매출", 0.15, ("md", 7, 10), 11),
)


def _anchor_dates(anchor: tuple, start: date, end: date) -> list[date]:
    if anchor[0] == "md":
        _, month, day = anchor
        return [
            candidate
            for year in range(start.year, end.year + 1)
            if (candidate := date(year, month, day)) and start <= candidate <= end
        ]
    _, name, before = anchor
    return [
        holiday - timedelta(days=before)
        for holiday, label in HOLIDAYS
        if label == name and start <= holiday - timedelta(days=before) <= end
    ]


def _campaigns(start: date, end: date, rng: random.Random) -> list[dict[str, Any]]:
    """달력에 맞춰 캠페인을 배치한다. 데이터 기간 안에 들어오는 것만 남는다."""
    out: list[dict[str, Any]] = []
    for name, category, objective, discount, anchor, length in CAMPAIGN_PLANS:
        for begin in _anchor_dates(anchor, start, end):
            finish = min(begin + timedelta(days=length - 1), end)
            out.append(
                {
                    "id": f"CMP-{begin:%Y%m%d}",
                    "name": name,
                    "category": category,
                    "objective": objective,
                    "start_date": begin.isoformat(),
                    "end_date": finish.isoformat(),
                    "budget": rng.choice((3_000_000, 5_000_000, 8_000_000, 12_000_000)),
                    "discount_rate": discount,
                }
            )
    out.sort(key=lambda item: item["start_date"])
    return out


def _active_campaign(campaigns: list[dict[str, Any]], day: str, category: str) -> dict[str, Any] | None:
    for campaign in campaigns:
        if campaign["start_date"] <= day <= campaign["end_date"] and campaign["category"] == category:
            return campaign
    return None


def _social(
    days: list[date],
    campaigns: list[dict[str, Any]],
    rng: random.Random,
) -> tuple[list[tuple], dict[tuple[str, str], int]]:
    """소셜 게시물과 (날짜, SKU)별 클릭 합계. 클릭은 이후 수요 상승에 쓴다."""
    posts: list[tuple] = []
    clicks_by: dict[tuple[str, str], int] = {}
    post_no = 0

    for day in days:
        iso = day.isoformat()
        month_factor = 0.85 + 0.3 * math.sin((day.timetuple().tm_yday / 365) * 2 * math.pi)
        live = [c for c in campaigns if c["start_date"] <= iso <= c["end_date"]]
        count = rng.randint(3, 6) if live else rng.randint(1, 3)

        for _ in range(count):
            post_no += 1
            campaign = rng.choice(live) if live and rng.random() < 0.75 else None
            pool = [p for p in PRODUCTS if campaign is None or p.category == campaign["category"]]
            product = rng.choice(pool) if rng.random() < 0.85 else None
            platform = rng.choice(PLATFORMS)
            is_ad = campaign is not None and rng.random() < 0.7

            base = {"인스타그램": 32000, "유튜브": 21000, "틱톡": 45000, "네이버블로그": 9000}[platform]
            impressions = int(base * month_factor * rng.uniform(0.5, 1.7))
            if is_ad:
                impressions = int(impressions * rng.uniform(2.0, 4.2))
            if rng.random() < 0.035:  # 바이럴
                impressions = int(impressions * rng.uniform(6.0, 18.0))

            ctr = rng.uniform(0.011, 0.038) * (1.25 if is_ad else 1.0)
            clicks = max(1, int(impressions * ctr))
            likes = int(impressions * rng.uniform(0.018, 0.062))
            comments = int(likes * rng.uniform(0.02, 0.09))
            shares = int(likes * rng.uniform(0.03, 0.14))
            spend = int(impressions * rng.uniform(9.0, 17.0)) if is_ad else 0

            posts.append(
                (
                    f"SP-{iso.replace('-', '')}-{post_no:05d}",
                    iso,
                    platform,
                    campaign["id"] if campaign else None,
                    product.sku if product else None,
                    1 if is_ad else 0,
                    impressions,
                    clicks,
                    likes,
                    comments,
                    shares,
                    spend,
                )
            )
            if product is not None:
                key = (iso, product.sku)
                clicks_by[key] = clicks_by.get(key, 0) + clicks

    return posts, clicks_by


def _social_lift(clicks_by: dict[tuple[str, str], int], days: list[date], index: int, sku: str) -> float:
    """직전 3일 클릭이 오늘 수요를 밀어 올린다. 하루 2000클릭이면 대략 +25%."""
    total = 0
    for back in (1, 2, 3):
        if index - back < 0:
            continue
        total += clicks_by.get((days[index - back].isoformat(), sku), 0) * (0.6 ** (back - 1))
    return 1.0 + min(0.9, total / 8000)


def _season(product: Product, day: date) -> float:
    return _gift_factor(day) if product.gift_set else product.season[day.month - 1]


def _forecast(product: Product, day: date) -> float:
    """그날 기준 일수요 추정치. 발주 담당자가 보는 숫자에 해당한다."""
    return product.base_demand * _season(product, day)


def _simulate_product(
    product: Product,
    days: list[date],
    campaigns: list[dict[str, Any]],
    clicks_by: dict[tuple[str, str], int],
    rng: random.Random,
) -> tuple[list[tuple], list[tuple]]:
    sales: list[tuple] = []
    inventory: list[tuple] = []

    launch = days[-1] - timedelta(days=product.launch_days_ago)
    on_hand = int(_forecast(product, days[0]) * (product.lead_time_days + product.safety_days) * 1.4)
    incoming: dict[str, int] = {}  # 도착일 -> 수량
    drift = rng.uniform(-0.12, 0.22)

    for index, day in enumerate(days):
        iso = day.isoformat()
        arrived = incoming.pop(iso, 0)
        on_hand += arrived

        season = _season(product, day)
        # 안전재고는 계절 수요에 따라 움직인다. 겨울 아우터는 겨울에 더 많이 깔아둔다.
        safety_stock = max(10, int(round(_forecast(product, day) * product.safety_days)))

        if day < launch:
            inventory.append((iso, product.sku, 0, 0, 0, safety_stock, 0))
            continue

        weekday = WEEKDAY[product.category][day.weekday()]
        payday = 1.12 if 21 <= day.day <= 26 else 1.0
        growth = 1.0 + (drift * index / len(days))
        ramp = min(1.0, 0.4 + 0.6 * ((day - launch).days / 30)) if (day - launch).days < 30 else 1.0

        campaign = _active_campaign(campaigns, iso, product.category)
        discount = campaign["discount_rate"] if campaign else 0.0
        campaign_lift = 1.0 + discount * 3.4 if campaign else 1.0

        demand = (
            product.base_demand
            * season
            * weekday
            * payday
            * growth
            * ramp
            * campaign_lift
            * _social_lift(clicks_by, days, index, product.sku)
            * max(0.25, rng.gauss(1.0, 0.17))
        )
        wanted = max(0, int(round(demand)))
        units = min(wanted, on_hand)
        on_hand -= units

        # 발주: 납기 동안 팔릴 양과 안전재고를 합친 발주점 아래로 떨어지면 채운다.
        # 도착 시점의 계절 수요로 계산하기 때문에 겨울 아우터는 가을에 미리 들여온다.
        lead = product.lead_time_days
        eta_demand = _forecast(product, day + timedelta(days=lead))
        reorder_point = eta_demand * lead + safety_stock
        pending = sum(incoming.values())
        if on_hand + pending < reorder_point:
            target = reorder_point + eta_demand * 21
            order = int(round(target - on_hand - pending))
            # 간혹 납품이 늦어지고, 그때 품절이 난다.
            delay = lead + (rng.randint(3, 11) if rng.random() < 0.07 else 0)
            eta = (day + timedelta(days=delay)).isoformat()
            incoming[eta] = incoming.get(eta, 0) + max(1, order)

        inventory.append(
            (iso, product.sku, on_hand, arrived, units, safety_stock, 1 if units < wanted else 0)
        )

        if units == 0:
            continue

        mix = CHANNEL_MIX[product.category]
        left = units
        for position, channel in enumerate(SALES_CHANNELS):
            if position == len(SALES_CHANNELS) - 1:
                part = left
            else:
                part = int(round(units * mix[position] * rng.uniform(0.85, 1.15)))
                part = min(part, left)
            left -= part
            if part <= 0:
                continue
            revenue = int(round(part * product.price * (1 - discount)))
            returns = int(round(part * product.return_rate * rng.uniform(0.4, 1.7)))
            sales.append((iso, product.sku, channel, part, revenue, round(discount, 3), min(returns, part)))

    return sales, inventory


SCHEMA = """
CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT NOT NULL,
  brand TEXT NOT NULL,
  price INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  description TEXT NOT NULL,
  attrs TEXT NOT NULL,
  return_rate REAL NOT NULL,
  launch_date TEXT NOT NULL
);
CREATE TABLE sales_daily (
  sale_date TEXT NOT NULL,
  sku TEXT NOT NULL,
  sales_channel TEXT NOT NULL,
  units INTEGER NOT NULL,
  revenue INTEGER NOT NULL,
  discount_rate REAL NOT NULL,
  returns_units INTEGER NOT NULL,
  PRIMARY KEY (sale_date, sku, sales_channel)
);
CREATE TABLE inventory_daily (
  snap_date TEXT NOT NULL,
  sku TEXT NOT NULL,
  on_hand INTEGER NOT NULL,
  inbound INTEGER NOT NULL,
  outbound INTEGER NOT NULL,
  safety_stock INTEGER NOT NULL,
  stockout INTEGER NOT NULL,
  PRIMARY KEY (snap_date, sku)
);
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  objective TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  budget INTEGER NOT NULL,
  discount_rate REAL NOT NULL
);
CREATE TABLE social_posts (
  id TEXT PRIMARY KEY,
  post_date TEXT NOT NULL,
  platform TEXT NOT NULL,
  campaign_id TEXT,
  sku TEXT,
  is_ad INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  likes INTEGER NOT NULL,
  comments INTEGER NOT NULL,
  shares INTEGER NOT NULL,
  spend INTEGER NOT NULL
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX idx_sales_date ON sales_daily (sale_date);
CREATE INDEX idx_sales_sku ON sales_daily (sku);
CREATE INDEX idx_inv_date ON inventory_daily (snap_date);
CREATE INDEX idx_social_date ON social_posts (post_date);
CREATE INDEX idx_social_sku ON social_posts (sku);
"""


def build(db_path: Path, end: date | None = None) -> dict[str, str]:
    """데모 DB를 새로 만든다. 기존 파일은 덮어쓴다."""
    end = end or date.today()
    days = [end - timedelta(days=DAYS - 1 - offset) for offset in range(DAYS)]
    rng = random.Random(SEED)

    campaigns = _campaigns(days[0], days[-1], rng)
    posts, clicks_by = _social(days, campaigns, rng)

    product_rows: list[tuple] = []
    sales_rows: list[tuple] = []
    inventory_rows: list[tuple] = []
    for product in PRODUCTS:
        launch = max(days[0], days[-1] - timedelta(days=product.launch_days_ago))
        product_rows.append(
            (
                product.sku,
                product.name,
                product.category,
                product.subcategory,
                product.brand,
                product.price,
                product.cost,
                product.description,
                json.dumps([list(pair) for pair in product.attrs], ensure_ascii=False),
                product.return_rate,
                launch.isoformat(),
            )
        )
        sales, inventory = _simulate_product(product, days, campaigns, clicks_by, rng)
        sales_rows.extend(sales)
        inventory_rows.extend(inventory)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = db_path.with_suffix(".tmp")
    tmp_path.unlink(missing_ok=True)

    conn = sqlite3.connect(tmp_path)
    try:
        conn.executescript(SCHEMA)
        conn.executemany("INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?)", product_rows)
        conn.executemany("INSERT INTO sales_daily VALUES (?,?,?,?,?,?,?)", sales_rows)
        conn.executemany("INSERT INTO inventory_daily VALUES (?,?,?,?,?,?,?)", inventory_rows)
        conn.executemany(
            "INSERT INTO campaigns VALUES (:id,:name,:category,:objective,:start_date,:end_date,:budget,:discount_rate)",
            campaigns,
        )
        conn.executemany("INSERT INTO social_posts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", posts)
        meta = {
            "schema_version": str(SCHEMA_VERSION),
            "seed": str(SEED),
            "start_date": days[0].isoformat(),
            "end_date": days[-1].isoformat(),
            "days": str(DAYS),
            "products": str(len(product_rows)),
            "sales_rows": str(len(sales_rows)),
            "social_rows": str(len(posts)),
            "campaigns": str(len(campaigns)),
        }
        conn.executemany("INSERT INTO meta VALUES (?,?)", list(meta.items()))
        conn.commit()
    finally:
        conn.close()

    db_path.unlink(missing_ok=True)
    tmp_path.replace(db_path)
    return meta


def run() -> None:
    """콘솔 스크립트. 데모 DB를 다시 만든다."""
    from .db import DB_PATH

    meta = build(DB_PATH)
    print(f"데모 데이터를 만들었습니다: {DB_PATH}")
    for key, value in meta.items():
        print(f"  {key}: {value}")
