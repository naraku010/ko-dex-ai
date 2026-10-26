"""쇼핑몰 데모 채널의 툴. 인자 모델이 그대로 manifest의 inputSchema가 된다.

제품·재고·판매·소셜 네 갈래를 조회한다. 이미지가 있는 툴은 ToolResult로 카드를 함께 보내
앱이 상품 카드를 바로 그리게 한다.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from channelkit import ToolError, ToolRegistry, ToolResult, card, cards
from pydantic import BaseModel, Field, field_validator

from . import db

registry = ToolRegistry()

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _check_date(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if not DATE_RE.match(text):
        raise ValueError("날짜는 YYYY-MM-DD 형식이어야 합니다.")
    return text


class PeriodArgs(BaseModel):
    start_date: str | None = Field(default=None, description="시작일 YYYY-MM-DD. 비우면 종료일 기준 최근 30일")
    end_date: str | None = Field(default=None, description="종료일 YYYY-MM-DD. 비우면 데이터의 마지막 날")

    _dates = field_validator("start_date", "end_date")(_check_date)


class CategoryPeriodArgs(PeriodArgs):
    category: Literal["의류", "식품"] | None = Field(default=None, description="카테고리. 비우면 전체")


# ── 기준 정보 ────────────────────────────────────────────────────────────────


@registry.tool(
    label="데이터 범위",
    description=(
        "이 쇼핑몰에 어떤 기간과 어떤 제품의 데이터가 있는지 알려준다. "
        "사용자가 기간을 말하지 않았거나 '작년', '지난달' 같은 상대 표현을 썼을 때 먼저 이 툴로 기준을 확인하라."
    ),
)
async def get_data_range() -> Any:
    start, end = db.data_range()
    rows = db.query(
        "SELECT category, COUNT(*) AS cnt FROM products GROUP BY category ORDER BY category"
    )
    campaigns = db.one("SELECT COUNT(*) AS cnt FROM campaigns")
    return {
        "데이터 기간": f"{start} ~ {end}",
        "시작일": start,
        "종료일": end,
        "카테고리별 제품수": {row["category"]: row["cnt"] for row in rows},
        "캠페인 수": campaigns["cnt"] if campaigns else 0,
        "판매경로": ["온라인몰", "모바일앱", "오프라인매장"],
        "소셜 채널": ["인스타그램", "유튜브", "틱톡", "네이버블로그"],
    }


# ── 제품 정보 ────────────────────────────────────────────────────────────────

PRODUCT_SELECT = """
SELECT p.sku, p.name, p.category, p.subcategory, p.brand, p.price, p.cost,
       p.description, p.attrs, p.return_rate, p.launch_date,
       COALESCE(i.on_hand, 0) AS on_hand,
       COALESCE(i.safety_stock, 0) AS safety_stock
  FROM products p
  LEFT JOIN inventory_daily i ON i.sku = p.sku AND i.snap_date = ?
"""


def _recent_units(sku: str, days: int = 30) -> int:
    row = db.one(
        "SELECT COALESCE(SUM(units), 0) AS units FROM sales_daily"
        " WHERE sku = ? AND sale_date > date(?, ?)",
        (sku, db.last_day(), f"-{days} day"),
    )
    return int(row["units"]) if row else 0


def _product_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "SKU": row["sku"],
        "제품명": row["name"],
        "카테고리": row["category"],
        "분류": row["subcategory"],
        "브랜드": row["brand"],
        "판매가": row["price"],
        "현재고": row["on_hand"],
        "이미지": db.image_url(row["sku"]),
    }


def _product_card(row: dict[str, Any], extra: dict[str, object] | None = None) -> dict[str, Any]:
    fields: dict[str, object] = {"판매가": db.won(row["price"]), "현재고": f"{row['on_hand']:,}개"}
    fields.update(extra or {})
    return card(
        title=row["name"],
        subtitle=f"{row['category']} · {row['subcategory']}",
        image=db.image_url(row["sku"]),
        badge=row["sku"],
        fields=fields,
    )


class SearchArgs(BaseModel):
    keyword: str | None = Field(default=None, description="제품명·분류·설명에서 찾을 단어. 비우면 전체")
    category: Literal["의류", "식품"] | None = Field(default=None, description="카테고리. 비우면 전체")
    limit: int = Field(default=8, ge=1, le=12, description="가져올 개수 (최대 12)")


@registry.tool(
    label="제품 검색",
    description=(
        "제품을 검색해 목록과 사진 카드를 보여준다. 제품이 뭐가 있는지, 어떤 옷·식품을 파는지 물어보면 이 툴을 쓴다. "
        "SKU를 이미 알고 자세한 내용이 필요하면 get_product_detail을 쓴다."
    ),
)
async def search_products(args: SearchArgs) -> Any:
    where = []
    params: list[Any] = [db.last_day()]
    if args.category:
        where.append("p.category = ?")
        params.append(args.category)
    if args.keyword:
        where.append("(p.name LIKE ? OR p.subcategory LIKE ? OR p.description LIKE ? OR p.sku LIKE ?)")
        like = f"%{args.keyword.strip()}%"
        params.extend([like, like, like, like])

    sql = PRODUCT_SELECT
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY p.category, p.price DESC LIMIT ?"
    params.append(args.limit)

    rows = db.query(sql, params)
    if not rows:
        raise ToolError("조건에 맞는 제품이 없습니다. 검색어나 카테고리를 바꿔보세요.")

    title = " ".join(filter(None, [args.category, args.keyword, "제품"])).strip()
    return ToolResult(
        data={"검색 결과": len(rows), "제품": [_product_row(row) for row in rows]},
        ui=[cards(title, [_product_card(row) for row in rows])],
    )


class SkuArgs(BaseModel):
    sku: str = Field(description="제품 코드. 예: AP-HOOD-01, FD-BREW-03")

    @field_validator("sku")
    @classmethod
    def _upper(cls, value: str) -> str:
        text = value.strip().upper()
        if not text:
            raise ValueError("SKU를 입력해주세요.")
        return text


@registry.tool(
    label="제품 상세",
    description=(
        "제품 한 개의 상세 정보를 사진과 함께 보여준다. 가격·원가·마진, 소재나 유통기한 같은 속성, "
        "현재고와 최근 30일 판매량을 함께 준다. SKU를 모르면 search_products로 먼저 찾는다."
    ),
)
async def get_product_detail(args: SkuArgs) -> Any:
    row = db.one(PRODUCT_SELECT + " WHERE p.sku = ?", (db.last_day(), args.sku))
    if not row:
        raise ToolError(f"{args.sku} 제품을 찾을 수 없습니다. search_products로 SKU를 확인해주세요.")

    units30 = _recent_units(row["sku"])
    attrs = db.parse_attrs(row["attrs"])
    margin = row["price"] - row["cost"]

    data = {
        **_product_row(row),
        "원가": row["cost"],
        "개당 마진": margin,
        "마진율": f"{margin / row['price'] * 100:.1f}%",
        "설명": row["description"],
        "속성": {label: value for label, value in attrs},
        "반품률": f"{row['return_rate'] * 100:.1f}%",
        "출시일": row["launch_date"],
        "안전재고": row["safety_stock"],
        "최근 30일 판매수량": units30,
    }
    fields: dict[str, object] = {
        "판매가": db.won(row["price"]),
        "현재고": f"{row['on_hand']:,}개",
        "30일 판매": f"{units30:,}개",
    }
    for label, value in attrs[:3]:
        fields[label] = value

    return ToolResult(
        data=data,
        ui=[cards(row["name"], [card(
            title=row["name"],
            subtitle=f"{row['brand']} · {row['category']} {row['subcategory']}",
            image=db.image_url(row["sku"]),
            badge=row["sku"],
            fields=fields,
        )])],
    )


# ── 재고 ────────────────────────────────────────────────────────────────────


class InventoryArgs(BaseModel):
    category: Literal["의류", "식품"] | None = Field(default=None, description="카테고리. 비우면 전체")
    risk_only: bool = Field(default=False, description="true면 안전재고 미달이나 품절 위험 제품만")
    limit: int = Field(default=15, ge=1, le=30, description="가져올 개수")


def _inventory_rows(category: str | None, risk_only: bool, limit: int) -> list[dict[str, Any]]:
    day = db.last_day()
    rows = db.query(
        """
        SELECT p.sku, p.name, p.category, p.subcategory, p.price,
               i.on_hand, i.safety_stock,
               (SELECT COALESCE(SUM(s.units), 0) / 14.0 FROM sales_daily s
                 WHERE s.sku = p.sku AND s.sale_date > date(?, '-14 day')) AS daily_units,
               (SELECT COUNT(*) FROM inventory_daily d
                 WHERE d.sku = p.sku AND d.stockout = 1 AND d.snap_date > date(?, '-30 day')) AS stockout_days
          FROM products p
          JOIN inventory_daily i ON i.sku = p.sku AND i.snap_date = ?
         WHERE (? IS NULL OR p.category = ?)
        """,
        (day, day, day, category, category),
    )

    out = []
    for row in rows:
        daily = float(row["daily_units"] or 0)
        cover = round(row["on_hand"] / daily, 1) if daily > 0.05 else None
        if row["on_hand"] == 0:
            status = "품절"
        elif row["on_hand"] < row["safety_stock"]:
            status = "안전재고 미달"
        elif cover is not None and cover < 10:
            status = "주의"
        else:
            status = "정상"
        if risk_only and status == "정상":
            continue
        out.append(
            {
                "SKU": row["sku"],
                "제품명": row["name"],
                "카테고리": row["category"],
                "현재고": row["on_hand"],
                "안전재고": row["safety_stock"],
                "일평균 판매": round(daily, 1),
                "재고 소진 예상일수": cover,
                "최근 30일 품절일수": row["stockout_days"],
                "상태": status,
            }
        )

    order = {"품절": 0, "안전재고 미달": 1, "주의": 2, "정상": 3}
    out.sort(key=lambda item: (order[item["상태"]], item["재고 소진 예상일수"] if item["재고 소진 예상일수"] is not None else 999))
    return out[:limit]


@registry.tool(
    label="재고 현황",
    description=(
        "제품별 현재고와 안전재고, 일평균 판매량으로 계산한 재고 소진 예상일수를 준다. "
        "재고가 얼마 남았는지, 품절 위험이 있는지 물어보면 이 툴을 쓴다. "
        "발주 수량까지 필요하면 get_restock_recommendations를 쓴다."
    ),
)
async def get_inventory_status(args: InventoryArgs) -> Any:
    rows = _inventory_rows(args.category, args.risk_only, args.limit)
    if not rows:
        return {"기준일": db.last_day(), "결과": "조건에 맞는 제품이 없습니다.", "제품": []}
    risky = [row for row in rows if row["상태"] != "정상"]
    return {
        "기준일": db.last_day(),
        "조회 제품수": len(rows),
        "위험 제품수": len(risky),
        "제품": rows,
    }


class RestockArgs(BaseModel):
    limit: int = Field(default=10, ge=1, le=24, description="가져올 개수")
    horizon_days: int = Field(default=30, ge=7, le=90, description="며칠치 재고를 목표로 할지 (기본 30일)")


@registry.tool(
    label="발주 권고",
    description=(
        "재고 소진이 임박한 제품에 대해 목표 일수만큼 채우기 위한 발주 수량과 예상 발주금액을 계산해 준다. "
        "무엇을 얼마나 발주해야 하는지 물어보면 이 툴을 쓴다."
    ),
)
async def get_restock_recommendations(args: RestockArgs) -> Any:
    rows = _inventory_rows(None, False, 100)
    out = []
    total = 0
    for row in rows:
        daily = row["일평균 판매"]
        if daily <= 0:
            continue
        target = daily * args.horizon_days
        need = int(round(target - row["현재고"]))
        if need <= 0:
            continue
        detail = db.one("SELECT cost FROM products WHERE sku = ?", (row["SKU"],))
        amount = need * int(detail["cost"]) if detail else 0
        total += amount
        out.append(
            {
                "SKU": row["SKU"],
                "제품명": row["제품명"],
                "카테고리": row["카테고리"],
                "현재고": row["현재고"],
                "일평균 판매": daily,
                "재고 소진 예상일수": row["재고 소진 예상일수"],
                "권고 발주수량": need,
                "예상 발주금액": amount,
                "상태": row["상태"],
            }
        )
    out.sort(key=lambda item: item["재고 소진 예상일수"] if item["재고 소진 예상일수"] is not None else 999)
    out = out[: args.limit]
    return {
        "기준일": db.last_day(),
        "목표 재고일수": args.horizon_days,
        "발주 대상": len(out),
        "예상 발주금액 합계": sum(item["예상 발주금액"] for item in out),
        "권고": out,
    }


# ── 판매 ────────────────────────────────────────────────────────────────────


class SalesSummaryArgs(CategoryPeriodArgs):
    granularity: Literal["day", "week", "month"] = Field(
        default="day", description="집계 단위. 기간이 길면 week나 month를 쓴다"
    )


@registry.tool(
    label="판매 요약",
    description=(
        "기간 매출·판매수량·반품·할인율을 집계하고 단위별 추이를 준다. 매출이 얼마인지, 늘었는지 줄었는지 물어보면 이 툴을 쓴다. "
        "기간을 말하지 않으면 최근 30일로 본다. 90일이 넘는 기간은 granularity를 week나 month로 올려라."
    ),
)
async def get_sales_summary(args: SalesSummaryArgs) -> Any:
    start, end = db.resolve_period(args.start_date, args.end_date)
    bucket = {
        "day": "s.sale_date",
        "week": "strftime('%Y-W%W', s.sale_date)",
        "month": "substr(s.sale_date, 1, 7)",
    }[args.granularity]

    params = (start, end, args.category, args.category)
    total = db.one(
        """
        SELECT COALESCE(SUM(s.revenue), 0) AS revenue, COALESCE(SUM(s.units), 0) AS units,
               COALESCE(SUM(s.returns_units), 0) AS returns,
               COALESCE(SUM(s.units * p.cost), 0) AS cost,
               COALESCE(AVG(s.discount_rate), 0) AS discount
          FROM sales_daily s JOIN products p ON p.sku = s.sku
         WHERE s.sale_date BETWEEN ? AND ? AND (? IS NULL OR p.category = ?)
        """,
        params,
    )
    trend = db.query(
        f"""
        SELECT {bucket} AS bucket, SUM(s.revenue) AS revenue, SUM(s.units) AS units
          FROM sales_daily s JOIN products p ON p.sku = s.sku
         WHERE s.sale_date BETWEEN ? AND ? AND (? IS NULL OR p.category = ?)
         GROUP BY bucket ORDER BY bucket
        """,
        params,
    )

    revenue = int(total["revenue"])
    units = int(total["units"])
    profit = revenue - int(total["cost"])
    return {
        "기간": f"{start} ~ {end}",
        "카테고리": args.category or "전체",
        "총 매출": revenue,
        "총 판매수량": units,
        "총 반품수량": int(total["returns"]),
        "반품률": f"{int(total['returns']) / units * 100:.1f}%" if units else "0.0%",
        "평균 할인율": f"{float(total['discount']) * 100:.1f}%",
        "매출총이익": profit,
        "매출총이익률": f"{profit / revenue * 100:.1f}%" if revenue else "0.0%",
        "평균 주문단가": int(revenue / units) if units else 0,
        "집계 단위": args.granularity,
        "추이": [
            {"구간": row["bucket"], "매출": int(row["revenue"]), "판매수량": int(row["units"])}
            for row in trend
        ],
    }


class TopProductsArgs(CategoryPeriodArgs):
    metric: Literal["revenue", "units", "profit"] = Field(
        default="revenue", description="정렬 기준. revenue=매출, units=수량, profit=매출총이익"
    )
    limit: int = Field(default=10, ge=1, le=12, description="가져올 개수 (최대 12)")


@registry.tool(
    label="판매 순위",
    description=(
        "기간 내 잘 팔린 제품 순위를 사진 카드와 함께 준다. 베스트셀러, 매출 1위, 많이 팔린 제품을 물어보면 이 툴을 쓴다. "
        "안 팔리는 제품을 찾을 때도 이 툴로 전체를 받아 아래쪽을 보면 된다."
    ),
)
async def get_top_products(args: TopProductsArgs) -> Any:
    start, end = db.resolve_period(args.start_date, args.end_date)
    order = {
        "revenue": "revenue DESC",
        "units": "units DESC",
        "profit": "profit DESC",
    }[args.metric]

    rows = db.query(
        f"""
        SELECT p.sku, p.name, p.category, p.subcategory, p.price,
               SUM(s.units) AS units, SUM(s.revenue) AS revenue,
               SUM(s.revenue) - SUM(s.units * p.cost) AS profit,
               SUM(s.returns_units) AS returns,
               COALESCE((SELECT i.on_hand FROM inventory_daily i
                          WHERE i.sku = p.sku AND i.snap_date = ?), 0) AS on_hand
          FROM sales_daily s JOIN products p ON p.sku = s.sku
         WHERE s.sale_date BETWEEN ? AND ? AND (? IS NULL OR p.category = ?)
         GROUP BY p.sku ORDER BY {order} LIMIT ?
        """,
        (db.last_day(), start, end, args.category, args.category, args.limit),
    )
    if not rows:
        raise ToolError(f"{start} ~ {end} 기간에 판매 데이터가 없습니다.")

    label = {"revenue": "매출", "units": "판매수량", "profit": "매출총이익"}[args.metric]
    ranked = []
    card_items = []
    for rank, row in enumerate(rows, start=1):
        ranked.append(
            {
                "순위": rank,
                "SKU": row["sku"],
                "제품명": row["name"],
                "카테고리": row["category"],
                "판매수량": int(row["units"]),
                "매출": int(row["revenue"]),
                "매출총이익": int(row["profit"]),
                "반품수량": int(row["returns"]),
                "현재고": int(row["on_hand"]),
                "이미지": db.image_url(row["sku"]),
            }
        )
        card_items.append(
            _product_card(
                row,
                {
                    "매출": db.won(row["revenue"]),
                    "판매": f"{int(row['units']):,}개",
                },
            )
        )

    return ToolResult(
        data={
            "기간": f"{start} ~ {end}",
            "카테고리": args.category or "전체",
            "정렬 기준": label,
            "순위": ranked,
        },
        ui=[cards(f"{label} 상위 {len(rows)}개 ({start} ~ {end})", card_items)],
    )


@registry.tool(
    label="판매경로별 실적",
    description=(
        "온라인몰·모바일앱·오프라인매장별 매출과 판매수량 비중을 준다. "
        "어느 경로에서 잘 팔리는지, 앱 비중이 얼마인지 물어보면 이 툴을 쓴다."
    ),
)
async def get_sales_by_channel(args: CategoryPeriodArgs) -> Any:
    start, end = db.resolve_period(args.start_date, args.end_date)
    rows = db.query(
        """
        SELECT s.sales_channel, SUM(s.revenue) AS revenue, SUM(s.units) AS units
          FROM sales_daily s JOIN products p ON p.sku = s.sku
         WHERE s.sale_date BETWEEN ? AND ? AND (? IS NULL OR p.category = ?)
         GROUP BY s.sales_channel ORDER BY revenue DESC
        """,
        (start, end, args.category, args.category),
    )
    total = sum(int(row["revenue"]) for row in rows) or 1
    return {
        "기간": f"{start} ~ {end}",
        "카테고리": args.category or "전체",
        "총 매출": total,
        "경로별": [
            {
                "판매경로": row["sales_channel"],
                "매출": int(row["revenue"]),
                "판매수량": int(row["units"]),
                "매출 비중": f"{int(row['revenue']) / total * 100:.1f}%",
            }
            for row in rows
        ],
    }


@registry.tool(
    label="카테고리 비교",
    description=(
        "의류와 식품을 나란히 비교한다. 매출·수량·마진율·반품률·할인율을 함께 준다. "
        "어느 쪽이 더 잘 되는지, 의류와 식품 차이를 물어보면 이 툴을 쓴다."
    ),
)
async def get_category_comparison(args: PeriodArgs) -> Any:
    start, end = db.resolve_period(args.start_date, args.end_date)
    rows = db.query(
        """
        SELECT p.category,
               SUM(s.revenue) AS revenue, SUM(s.units) AS units,
               SUM(s.returns_units) AS returns,
               SUM(s.units * p.cost) AS cost,
               AVG(s.discount_rate) AS discount,
               COUNT(DISTINCT p.sku) AS skus
          FROM sales_daily s JOIN products p ON p.sku = s.sku
         WHERE s.sale_date BETWEEN ? AND ?
         GROUP BY p.category ORDER BY revenue DESC
        """,
        (start, end),
    )
    total = sum(int(row["revenue"]) for row in rows) or 1
    out = []
    for row in rows:
        revenue = int(row["revenue"])
        units = int(row["units"])
        profit = revenue - int(row["cost"])
        out.append(
            {
                "카테고리": row["category"],
                "제품수": int(row["skus"]),
                "매출": revenue,
                "매출 비중": f"{revenue / total * 100:.1f}%",
                "판매수량": units,
                "매출총이익": profit,
                "마진율": f"{profit / revenue * 100:.1f}%" if revenue else "0.0%",
                "반품률": f"{int(row['returns']) / units * 100:.1f}%" if units else "0.0%",
                "평균 할인율": f"{float(row['discount']) * 100:.1f}%",
                "평균 판매단가": int(revenue / units) if units else 0,
            }
        )
    return {"기간": f"{start} ~ {end}", "총 매출": total, "카테고리": out}


# ── 마케팅 / 소셜 ────────────────────────────────────────────────────────────

PLATFORM = Literal["인스타그램", "유튜브", "틱톡", "네이버블로그"]


class SocialArgs(PeriodArgs):
    platform: PLATFORM | None = Field(default=None, description="소셜 채널. 비우면 전체")


@registry.tool(
    label="소셜 요약",
    description=(
        "소셜 채널별 노출·클릭·좋아요·댓글·공유와 광고비, CTR, 참여율을 집계한다. "
        "마케팅 성과, 인스타 반응, 광고비 대비 효율을 물어보면 이 툴을 쓴다."
    ),
)
async def get_social_summary(args: SocialArgs) -> Any:
    start, end = db.resolve_period(args.start_date, args.end_date)
    params = (start, end, args.platform, args.platform)
    rows = db.query(
        """
        SELECT platform, COUNT(*) AS posts,
               SUM(impressions) AS impressions, SUM(clicks) AS clicks,
               SUM(likes) AS likes, SUM(comments) AS comments, SUM(shares) AS shares,
               SUM(spend) AS spend, SUM(is_ad) AS ads
          FROM social_posts
         WHERE post_date BETWEEN ? AND ? AND (? IS NULL OR platform = ?)
         GROUP BY platform ORDER BY impressions DESC
        """,
        params,
    )
    if not rows:
        raise ToolError(f"{start} ~ {end} 기간에 소셜 데이터가 없습니다.")

    def summarize(row: dict[str, Any]) -> dict[str, Any]:
        impressions = int(row["impressions"])
        clicks = int(row["clicks"])
        engage = int(row["likes"]) + int(row["comments"]) + int(row["shares"])
        spend = int(row["spend"])
        return {
            "소셜 채널": row["platform"],
            "게시물수": int(row["posts"]),
            "광고 게시물수": int(row["ads"]),
            "노출": impressions,
            "클릭": clicks,
            "CTR": f"{clicks / impressions * 100:.2f}%" if impressions else "0.00%",
            "좋아요": int(row["likes"]),
            "댓글": int(row["comments"]),
            "공유": int(row["shares"]),
            "참여율": f"{engage / impressions * 100:.2f}%" if impressions else "0.00%",
            "광고비": spend,
            "클릭당 비용": int(spend / clicks) if clicks and spend else 0,
        }

    per_platform = [summarize(row) for row in rows]
    return {
        "기간": f"{start} ~ {end}",
        "총 노출": sum(item["노출"] for item in per_platform),
        "총 클릭": sum(item["클릭"] for item in per_platform),
        "총 광고비": sum(item["광고비"] for item in per_platform),
        "채널별": per_platform,
    }


class TopPostsArgs(SocialArgs):
    limit: int = Field(default=10, ge=1, le=20, description="가져올 개수")
    metric: Literal["impressions", "clicks", "engagement"] = Field(
        default="impressions", description="정렬 기준"
    )


@registry.tool(
    label="소셜 인기 게시물",
    description=(
        "노출·클릭·참여가 높은 게시물을 순위로 준다. 어떤 콘텐츠가 반응이 좋았는지, "
        "바이럴이 터진 게시물이 있는지 물어보면 이 툴을 쓴다. 게시물에 연결된 제품 SKU도 함께 준다."
    ),
)
async def get_top_posts(args: TopPostsArgs) -> Any:
    start, end = db.resolve_period(args.start_date, args.end_date)
    order = {
        "impressions": "s.impressions DESC",
        "clicks": "s.clicks DESC",
        "engagement": "(s.likes + s.comments + s.shares) DESC",
    }[args.metric]

    rows = db.query(
        f"""
        SELECT s.id, s.post_date, s.platform, s.campaign_id, s.sku, s.is_ad,
               s.impressions, s.clicks, s.likes, s.comments, s.shares, s.spend,
               p.name AS product_name, c.name AS campaign_name
          FROM social_posts s
          LEFT JOIN products p ON p.sku = s.sku
          LEFT JOIN campaigns c ON c.id = s.campaign_id
         WHERE s.post_date BETWEEN ? AND ? AND (? IS NULL OR s.platform = ?)
         ORDER BY {order} LIMIT ?
        """,
        (start, end, args.platform, args.platform, args.limit),
    )
    return {
        "기간": f"{start} ~ {end}",
        "정렬 기준": args.metric,
        "게시물": [
            {
                "게시일": row["post_date"],
                "소셜 채널": row["platform"],
                "광고": bool(row["is_ad"]),
                "캠페인": row["campaign_name"],
                "제품": row["product_name"],
                "SKU": row["sku"],
                "노출": int(row["impressions"]),
                "클릭": int(row["clicks"]),
                "CTR": f"{int(row['clicks']) / int(row['impressions']) * 100:.2f}%" if row["impressions"] else "0.00%",
                "좋아요": int(row["likes"]),
                "댓글": int(row["comments"]),
                "공유": int(row["shares"]),
                "광고비": int(row["spend"]),
            }
            for row in rows
        ],
    }


class CampaignArgs(PeriodArgs):
    campaign_id: str | None = Field(default=None, description="캠페인 ID. 비우면 기간에 걸친 캠페인 전체")


@registry.tool(
    label="캠페인 성과",
    description=(
        "캠페인별 기간·예산·할인율과 그 기간의 소셜 노출·클릭·광고비, 해당 카테고리 매출을 묶어서 준다. "
        "어떤 기획전이 성과가 좋았는지, 광고비 대비 매출(ROAS)을 물어보면 이 툴을 쓴다."
    ),
)
async def get_campaign_results(args: CampaignArgs) -> Any:
    if args.campaign_id:
        campaigns = db.query("SELECT * FROM campaigns WHERE id = ?", (args.campaign_id.strip(),))
        if not campaigns:
            raise ToolError(f"{args.campaign_id} 캠페인을 찾을 수 없습니다. campaign_id를 비우면 전체를 봅니다.")
        period = f"{campaigns[0]['start_date']} ~ {campaigns[0]['end_date']}"
    else:
        start, end = db.resolve_period(args.start_date, args.end_date, default_days=365)
        campaigns = db.query(
            "SELECT * FROM campaigns WHERE start_date <= ? AND end_date >= ? ORDER BY start_date",
            (end, start),
        )
        period = f"{start} ~ {end}"
        if not campaigns:
            raise ToolError(f"{period} 기간에 진행한 캠페인이 없습니다.")

    out = []
    for campaign in campaigns:
        social = db.one(
            """
            SELECT COALESCE(SUM(impressions), 0) AS impressions, COALESCE(SUM(clicks), 0) AS clicks,
                   COALESCE(SUM(spend), 0) AS spend, COUNT(*) AS posts
              FROM social_posts WHERE campaign_id = ?
            """,
            (campaign["id"],),
        )
        sales = db.one(
            """
            SELECT COALESCE(SUM(s.revenue), 0) AS revenue, COALESCE(SUM(s.units), 0) AS units
              FROM sales_daily s JOIN products p ON p.sku = s.sku
             WHERE s.sale_date BETWEEN ? AND ? AND p.category = ?
            """,
            (campaign["start_date"], campaign["end_date"], campaign["category"]),
        )
        spend = int(social["spend"])
        revenue = int(sales["revenue"])
        out.append(
            {
                "캠페인 ID": campaign["id"],
                "캠페인명": campaign["name"],
                "대상 카테고리": campaign["category"],
                "목표": campaign["objective"],
                "기간": f"{campaign['start_date']} ~ {campaign['end_date']}",
                "예산": int(campaign["budget"]),
                "할인율": f"{float(campaign['discount_rate']) * 100:.0f}%",
                "게시물수": int(social["posts"]),
                "노출": int(social["impressions"]),
                "클릭": int(social["clicks"]),
                "집행 광고비": spend,
                "기간 매출": revenue,
                "판매수량": int(sales["units"]),
                "ROAS": f"{revenue / spend:.1f}배" if spend else "광고비 없음",
            }
        )
    return {"조회 기간": period, "캠페인 수": len(out), "캠페인": out}


# ── 브리핑 ──────────────────────────────────────────────────────────────────


class BriefingArgs(BaseModel):
    target_date: str | None = Field(default=None, description="기준일 YYYY-MM-DD. 비우면 데이터의 마지막 날")

    _dates = field_validator("target_date")(_check_date)


@registry.tool(
    label="오늘 브리핑",
    description=(
        "하루치 종합 브리핑. 그날 매출·판매수량, 전일 대비와 전주 동일 요일 대비 증감, 잘 팔린 제품, "
        "품절·안전재고 미달 제품, 소셜 반응, 진행 중인 캠페인을 한 번에 준다. "
        "'오늘 어때', '상황 알려줘', '브리핑' 같은 요청에는 이 툴을 먼저 쓴다."
    ),
)
async def get_daily_briefing(args: BriefingArgs) -> Any:
    day = db.resolve_day(args.target_date)

    def day_total(target: str) -> dict[str, int]:
        row = db.one(
            "SELECT COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(units), 0) AS units"
            " FROM sales_daily WHERE sale_date = ?",
            (target,),
        )
        return {"revenue": int(row["revenue"]), "units": int(row["units"])}

    today = day_total(day)
    prev = db.one("SELECT date(?, '-1 day') AS d", (day,))["d"]
    week = db.one("SELECT date(?, '-7 day') AS d", (day,))["d"]
    yesterday = day_total(prev)
    last_week = day_total(week)

    def delta(now: int, before: int) -> str:
        if before == 0:
            return "비교 불가"
        return f"{(now - before) / before * 100:+.1f}%"

    top = db.query(
        """
        SELECT p.name, p.category, SUM(s.units) AS units, SUM(s.revenue) AS revenue
          FROM sales_daily s JOIN products p ON p.sku = s.sku
         WHERE s.sale_date = ? GROUP BY p.sku ORDER BY revenue DESC LIMIT 5
        """,
        (day,),
    )
    risk = db.query(
        """
        SELECT p.sku, p.name, i.on_hand, i.safety_stock, i.stockout
          FROM inventory_daily i JOIN products p ON p.sku = i.sku
         WHERE i.snap_date = ? AND (i.stockout = 1 OR i.on_hand < i.safety_stock)
         ORDER BY i.on_hand ASC LIMIT 8
        """,
        (day,),
    )
    social = db.one(
        """
        SELECT COUNT(*) AS posts, COALESCE(SUM(impressions), 0) AS impressions,
               COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(spend), 0) AS spend
          FROM social_posts WHERE post_date = ?
        """,
        (day,),
    )
    live = db.query(
        "SELECT id, name, category, end_date, discount_rate FROM campaigns"
        " WHERE start_date <= ? AND end_date >= ?",
        (day, day),
    )

    return {
        "기준일": day,
        "매출": today["revenue"],
        "판매수량": today["units"],
        "전일 대비": delta(today["revenue"], yesterday["revenue"]),
        "전주 동일요일 대비": delta(today["revenue"], last_week["revenue"]),
        "잘 팔린 제품": [
            {"제품명": row["name"], "카테고리": row["category"], "판매수량": int(row["units"]), "매출": int(row["revenue"])}
            for row in top
        ],
        "재고 주의": [
            {
                "SKU": row["sku"],
                "제품명": row["name"],
                "현재고": int(row["on_hand"]),
                "안전재고": int(row["safety_stock"]),
                "상태": "품절" if row["stockout"] else "안전재고 미달",
            }
            for row in risk
        ],
        "소셜": {
            "게시물수": int(social["posts"]),
            "노출": int(social["impressions"]),
            "클릭": int(social["clicks"]),
            "광고비": int(social["spend"]),
        },
        "진행 중 캠페인": [
            {
                "캠페인 ID": row["id"],
                "캠페인명": row["name"],
                "대상": row["category"],
                "종료일": row["end_date"],
                "할인율": f"{float(row['discount_rate']) * 100:.0f}%",
            }
            for row in live
        ],
    }
