import { type ProductScraper, type ProductScraperResult, type Snus } from "../../types"
import { decodeEntities } from "../../util/decodeEntities"
import { extractSpecificFlavor } from "../../util/extractSpecificFlavor"
import { getBroadFlavor } from "../../util/getBroadFlavor"
import { getBestValue } from "../../util/getBestValue"
import { mapLimited } from "../../util/mapLimited"

// snushandel is WooCommerce, and its Store API is public
const API_URL = "https://www.snushandel.se/wp-json/wc/store/v1/products"
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
}
const PRODUCT_FIELDS = "id,name,type,permalink,description,short_description,is_in_stock,is_purchasable,prices,categories,attributes"
const VARIATION_FIELDS = "id,parent,variation,prices,is_in_stock"
// uncached pages take ~0.15s per product server side, and the server seems to handle only a couple of requests at once,
// so firing every page at once just queues them. this keeps it polite without being slower
const PAGE_CONCURRENCY = 3
const DEFAULT_POUCHES = 20

// not single-flavor nicotine snus, or (Datum) clearance copies of regular products
const EXCLUDED_CATEGORIES = new Set([
    "nikotinfritt-snus", "cbd-snus", "gor-eget-snus", "mix-pack-snus", "datum-markt-snus",
])

// the parts of a Store API product we use. variations have `parent` and `variation` (e.g. "Antal: 10-Pack")
type StoreProduct = {
    id: number
    parent: number
    name: string
    type: "simple" | "variable" | "variation"
    variation: string
    permalink: string
    description: string
    short_description: string
    is_in_stock: boolean
    is_purchasable: boolean
    prices: { price: string, currency_minor_unit: number }
    categories: { slug: string }[]
    attributes?: { taxonomy: string | null, terms: { name: string }[] }[]
}

// query is e.g. "category=portionssnus&_fields=..."
async function fetchAll(query: string): Promise<StoreProduct[]> {
    const fetchPage = async (page: number) => {
        const url = `${API_URL}?per_page=100&page=${page}&${query}`
        const res = await fetch(url, { headers: HEADERS })
        if (!res.ok) throw new Error(`snushandel: ${res.status} for ${url}`)
        return { products: await res.json() as StoreProduct[], totalPages: parseInt(res.headers.get("x-wp-totalpages") ?? "1") }
    }

    const first = await fetchPage(1)
    const pageNumbers = Array.from({ length: first.totalPages - 1 }, (_, i) => i + 2)
    const rest = await mapLimited(pageNumbers, PAGE_CONCURRENCY, fetchPage)
    return [first, ...rest].flatMap(page => page.products)
}

function parseNumber(text: string): number {
    return parseFloat(text.replace(",", "."))
}

// "VELO Shift Pomelo Peppercorn #3 – 1 Dosa" -> "VELO Shift Pomelo Peppercorn #3"
function cleanName(name: string): string {
    return decodeEntities(name).replace(/\s*[–|-]\s*1 Dosan?\s*$/i, "").trim()
}

// descriptions end with a list of related products, whose names and prices would get picked up by the regexes
function descriptionText(product: StoreProduct): string {
    const description = product.description.split('<div class="woocommerce')[0]!
    return decodeEntities(`${description} ${product.short_description}`.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ")
}

// the fact list/table has e.g. "<strong>Smak:</strong> Mint</li>" or "<td class="spec-key">Smak</td><td ...>Mint</td>"
function getSpec(product: StoreProduct, key: string): string | undefined {
    const html = product.description
    const value = html.match(new RegExp(`<strong>${key}:</strong>\\s*([^<]+)`))?.[1]
        ?? html.match(new RegExp(`spec-key">${key}</td>\\s*<td[^>]*>([^<]+)<`))?.[1]
    return value ? decodeEntities(value).trim() || undefined : undefined
}

const NUM = String.raw`(\d+(?:[,.]\d+)?)`

function matchNumber(text: string, patterns: string[]): number | undefined {
    for (const pattern of patterns) {
        const match = text.match(new RegExp(pattern, "i"))
        if (match) return parseNumber(match[1]!)
    }
    return undefined
}

function getPouches(text: string): number | undefined {
    const pouches = matchNumber(text, [
        String.raw`Antal\s*(?:portioner|prillor|påsar)?\s*(?:(?:per|/)\s*(?:dosa|förpackning|tub|påse))?\s*:?\s*(\d+)`,
        String.raw`(\d+)\s*(?:st(?:ycken)?\s*)?(?:portioner|prillor|nikotinpåsar|nikotinportioner)\b`,
    ])
    return pouches && pouches >= 5 && pouches <= 1000 ? pouches : undefined
}

// grams per pouch, from the pack weight ("Innehåll/förpackning (gram) 16g") divided by pouches,
// or a pouch weight ("Vikt per portion (gram) 0,71 g", "Vikt 0,8 g"). "Vikt" is sometimes the pack weight, so small ones are per pouch
function getPouchGrams(text: string, pouches: number): number | undefined {
    const packGrams = matchNumber(text, [
        String.raw`(?:Innehåll/förpackning|Innehåll|Nettovikt)\s*(?:\(gram\))?:?\s*${NUM}\s*g\b`,
        String.raw`totalt\s*${NUM}\s*g(?:ram)?\b`,
    ])
    const weight = matchNumber(text, [String.raw`Vikt(?:\s*per\s*(?:portion|prilla))?\s*(?:\(gram\))?:?\s*${NUM}\s*g\b`])
    if (packGrams) return packGrams / pouches
    if (weight) return weight < 3 ? weight : weight / pouches
    return undefined
}

// descriptions are hand written, so try per-pouch mg in the text, then mg/g × grams per pouch, then the name.
// the name goes last because names like "CUBA Black 43mg" or "Siberia 43mg" are mg/g
function getMgPerPouch(name: string, text: string, pouchGrams: number | undefined): number | undefined {
    const perPouch = matchNumber(text, [
        String.raw`Nikotinhalt\s*\(?mg/(?:portion|prilla)\)?:?\s*${NUM}\s*mg`,
        String.raw`Nikotin(?:halt)?\s*(?:per|/)\s*(?:prilla|portion)\s*:?\s*(?:är\s*)?${NUM}\s*mg`,
        String.raw`${NUM}\s*mg\s*(?:nikotin\s*)?(?:per|/)\s*(?:prilla|portion|påse)`,
        String.raw`(?:prilla|portion|påse)\s*innehåller\s*${NUM}\s*mg`,
        String.raw`Nikotinhalt:?\s*${NUM}\s*mg(?!\s*(?:/|per)\s*g)`,
    ])
    if (perPouch) return perPouch

    const mgPerGram = matchNumber(text, [String.raw`${NUM}\s*mg\s*(?:/|per)\s*g(?:ram)?\b`])
    if (mgPerGram && pouchGrams) return Math.round(mgPerGram * pouchGrams * 10) / 10

    return matchNumber(name, [String.raw`${NUM}\s?mg\b(?!\s*/\s*g)`])
}

// the "Format" spec is sometimes junk like "White portion Islay Whisky", so only trust the plain ones
function getFormat(product: StoreProduct): string | undefined {
    const format = getSpec(product, "Format")
    if (format && /^(normal|slim|super ?slim|mini|large)$/i.test(format)) return format[0]!.toUpperCase() + format.slice(1).toLowerCase()
    if (product.categories.some(c => c.slug === "slim-portionssnus")) return "Slim"
    if (product.categories.some(c => c.slug === "mini-portionssnus")) return "Mini"
    if (product.categories.some(c => c.slug === "vanligt-portionssnus")) return "Normal"
    return undefined
}

// "Antal: 10-Pack", "Välj Antal: 5 Dosor", "1 Dosa", "1-Påse" -> 10, 5, 1, 1
function parsePackSize(variation: string): number {
    return parseInt(variation.replace(/^.*?:\s*/, "").match(/\d+/)?.[0] ?? "")
}

function parsePrice(product: StoreProduct): number {
    // prices are strings in minor units, e.g. "4200" with currency_minor_unit 2 is 42,00 kr
    return parseInt(product.prices.price) / 10 ** product.prices.currency_minor_unit
}

export const scrape: ProductScraper = async () => {
    const [products, variations] = await Promise.all([
        fetchAll(`category=portionssnus&_fields=${PRODUCT_FIELDS}`),
        fetchAll(`type=variation&_fields=${VARIATION_FIELDS}`),
    ])

    // not purchasable means discontinued/coming soon. those have no price at all
    const snusProducts = products.filter(product => (
        product.is_in_stock &&
        product.is_purchasable &&
        !product.categories.some(c => EXCLUDED_CATEGORIES.has(c.slug))
    ))

    // pack size -> price, per product id. price 0 means not for sale
    const pricesById = new Map<number, Map<number, number>>()
    const setPrice = (id: number, pack: number, price: number) => {
        if (!pack || !price) return
        const prices = pricesById.get(id) ?? new Map<number, number>()
        prices.set(pack, Math.min(price, prices.get(pack) ?? Infinity))
        pricesById.set(id, prices)
    }
    for (const variation of variations) {
        if (variation.is_in_stock) setPrice(variation.parent, parsePackSize(variation.variation), parsePrice(variation))
    }

    // the cheap 1-can offers ("... – 1 Dosa", e.g. 15 kr) are separate simple products,
    // so fold them into the regular product with the same name when there is one
    const variableByName = new Map(
        snusProducts.filter(p => p.type === "variable").map(p => [cleanName(p.name).toLowerCase(), p.id])
    )
    const standalone: StoreProduct[] = []
    for (const product of snusProducts) {
        if (product.type === "variable") {
            standalone.push(product)
            continue
        }
        const parentId = variableByName.get(cleanName(product.name).toLowerCase())
        setPrice(parentId ?? product.id, 1, parsePrice(product))
        if (!parentId) standalone.push(product)
    }

    const snus = standalone.flatMap((product): Snus[] => {
        const prices = [...pricesById.get(product.id) ?? []]
            .map(([pack, price]): [number, number] => [price, pack])
            .sort((a, b) => a[1] - b[1])
        if (!prices.length) return []

        const name = cleanName(product.name)
        const text = descriptionText(product)
        // a pouch weighs roughly 0.3-1.5 g, so a count that doesn't fit the pack weight is a typo (e.g. "224" for 24)
        let pouchesPerContainer = getPouches(text)
        let pouchGrams = getPouchGrams(text, pouchesPerContainer ?? DEFAULT_POUCHES)
        if (pouchGrams && (pouchGrams < 0.2 || pouchGrams > 2)) {
            pouchesPerContainer = undefined
            pouchGrams = getPouchGrams(text, DEFAULT_POUCHES)
            if (pouchGrams && (pouchGrams < 0.2 || pouchGrams > 2)) pouchGrams = undefined
        }
        const mgPerPouch = getMgPerPouch(name, text, pouchGrams)
        if (!mgPerPouch || mgPerPouch > 100) return []

        const brand = decodeEntities(
            product.attributes?.find(a => a.taxonomy === "pa_varumarken")?.terms[0]?.name ?? name.split(" ")[0]!
        )
        const vitt = product.categories.some(c => c.slug === "vitt-snus" || c.slug === "nikotinpasar")

        return [{
            vitt,
            format: getFormat(product),
            brand,
            flavor: {
                broad: getBroadFlavor(getSpec(product, "Smak"), name),
                specific: extractSpecificFlavor(name, brand),
            },
            mgPerPouch,
            pouchesPerContainer,
            prices,
            bestValue: getBestValue(prices),
            // @ts-expect-error snushandel is disabled in types.ts, see DOC.md. remove this when re-enabling
            provider: "snushandel",
            url: product.permalink,
        }]
    })

    // typed here rather than via the return, so the error below lands on `provider` instead of on `scrape`
    const result: ProductScraperResult = {
        date: new Date(),
        // @ts-expect-error snushandel is disabled in types.ts, see DOC.md. remove this when re-enabling
        provider: "snushandel",
        products: snus,
    }
    return result
}
