import { type ProductScraper, type Snus } from "../../types"
import { decodeEntities } from "../../util/decodeEntities"
import { extractSpecificFlavor } from "../../util/extractSpecificFlavor"
import { getBestValue } from "../../util/getBestValue"
import { getBroadFlavor } from "../../util/getBroadFlavor"
import { mapLimited } from "../../util/mapLimited"

// minprilla is WooCommerce, and its Store API is public. ~2s per request of 100, uncached
const API_URL = "https://minprilla.se/wp-json/wc/store/v1/products"
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
}
const PRODUCT_FIELDS = "id,name,type,permalink,description,short_description,is_in_stock,is_purchasable,prices,categories,attributes,variations"
const VARIATION_FIELDS = "id,parent,variation,prices,is_in_stock"
const CONCURRENCY = 5

// 32 portionssnus, 33 white portion, 34 slim portion, 88 mini portion, 35 vitt snus (includes its slim/mini/large subcategories)
const SNUS_CATEGORIES = "32,33,34,35,88"
const VITT_CATEGORIES = new Set(["vitt-snus", "slim", "mini", "vitt-snus-large"])

// not single-flavor nicotine snus
const EXCLUDED_CATEGORIES = new Set([
    "mixpack-snus", "mixpack-vitt-snus", "nikotinfritt-snus", "cbd-snus", "koffeinsnus", "gora-eget-snus",
    "lossnus", "utgangna-produkter",
])

// the parts of a Store API product we use. variations have `parent` and `variation` (e.g. "Antal: 10-p")
type StoreProduct = {
    id: number
    parent: number
    name: string
    type: string
    variation: string
    permalink: string
    description: string
    short_description: string
    is_in_stock: boolean
    is_purchasable: boolean
    prices: { price: string, currency_minor_unit: number }
    categories: { slug: string }[]
    attributes?: { taxonomy: string | null, terms: { name: string }[] }[]
    variations?: { id: number }[]
}

async function fetchPage(query: string, page: number) {
    const url = `${API_URL}?per_page=100&page=${page}&${query}`
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) throw new Error(`minprilla: ${res.status} for ${url}`)
    return { products: await res.json() as StoreProduct[], totalPages: parseInt(res.headers.get("x-wp-totalpages") ?? "1") }
}

async function fetchAll(query: string): Promise<StoreProduct[]> {
    const first = await fetchPage(query, 1)
    const pageNumbers = Array.from({ length: first.totalPages - 1 }, (_, i) => i + 2)
    const rest = await mapLimited(pageNumbers, CONCURRENCY, page => fetchPage(query, page))
    return [first, ...rest].flatMap(page => page.products)
}

// there are ~7000 variations in total (mostly vapes), so only fetch the ones we need, 100 ids at a time
async function fetchVariations(ids: number[]): Promise<StoreProduct[]> {
    const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, i * 100 + 100))
    const pages = await mapLimited(chunks, CONCURRENCY, chunk => fetchPage(
        `type=variation&_fields=${VARIATION_FIELDS}&${chunk.map(id => `include[]=${id}`).join("&")}`, 1
    ))
    return pages.flatMap(page => page.products)
}

const NUM = String.raw`(\d+(?:[,.]\d+)?)`

function matchNumber(text: string, patterns: string[]): number | undefined {
    for (const pattern of patterns) {
        const match = text.match(new RegExp(pattern, "i"))
        if (match) return parseFloat(match[1]!.replace(",", "."))
    }
    return undefined
}

// descriptions are generated and consistent: "... med 14 mg nikotin per prilla. I dosan ligger 20 prillor à 0,6 gram."
function descriptionText(product: StoreProduct): string {
    return decodeEntities(`${product.short_description} ${product.description}`.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ")
}

function getMgPerPouch(name: string, text: string): number | undefined {
    return matchNumber(text, [
        String.raw`${NUM}\s*mg\s*(?:nikotin\s*)?per\s*prilla`,
        String.raw`prilla\s*innehåller\s*${NUM}\s*mg`,
    ]) ?? matchNumber(name, [String.raw`${NUM}\s?mg\b`])
}

function getPouches(text: string): number | undefined {
    const pouches = matchNumber(text, [String.raw`(\d+)\s*prillor\b`])
    return pouches && pouches >= 5 && pouches <= 1000 ? pouches : undefined
}

// the `brands` field is empty, but descriptions link brands, e.g. <a href="https://minprilla.se/varumarken/zyn/">ZYN</a>.
// they often link the manufacturer too ("Swedish Match"), so use the longest link the name starts with
function getBrand(product: StoreProduct, name: string): string {
    const links = [...product.description.matchAll(/href="https:\/\/minprilla\.se\/varumarken\/[^"]+"[^>]*>([^<]+)</g)]
        .map(match => decodeEntities(match[1]!).trim())
    const lowerName = name.toLowerCase()
    const brand = links
        .filter(link => lowerName.startsWith(link.toLowerCase() + " "))
        .sort((a, b) => b.length - a.length)[0]
    return brand ?? name.split(" ")[0]!
}

function getFormat(product: StoreProduct): string | undefined {
    const slugs = product.categories.map(c => c.slug)
    if (slugs.includes("slim") || slugs.includes("slim-portion")) return "Slim"
    if (slugs.includes("mini") || slugs.includes("mini-portion")) return "Mini"
    if (slugs.includes("vitt-snus-large")) return "Large"
    return undefined
}

// "Antal: 10-p", "Antal: Dosa" -> 10, 1
function parsePackSize(variation: string): number {
    const value = variation.replace(/^.*?:\s*/, "")
    if (/^dosa$/i.test(value)) return 1
    return parseInt(value.match(/\d+/)?.[0] ?? "")
}

function parsePrice(product: StoreProduct): number {
    // prices are strings in minor units, e.g. "4200" with currency_minor_unit 2 is 42,00 kr
    return parseInt(product.prices.price) / 10 ** product.prices.currency_minor_unit
}

export const scrape: ProductScraper = async () => {
    const products = (await fetchAll(`category=${SNUS_CATEGORIES}&_fields=${PRODUCT_FIELDS}`)).filter(product => (
        product.is_in_stock &&
        product.is_purchasable &&
        !product.categories.some(c => EXCLUDED_CATEGORIES.has(c.slug))
    ))

    const variations = await fetchVariations(products.flatMap(product => product.variations?.map(v => v.id) ?? []))

    // pack size -> price, per product id. price 0 means not for sale.
    // "Dosa" is sometimes a 14,90 kr campaign price (category dosor-for-15-kr), which is kept as is
    const pricesById = new Map<number, Map<number, number>>()
    for (const variation of variations) {
        const pack = parsePackSize(variation.variation)
        const price = parsePrice(variation)
        if (!variation.is_in_stock || !pack || !price) continue
        const prices = pricesById.get(variation.parent) ?? new Map<number, number>()
        prices.set(pack, price)
        pricesById.set(variation.parent, prices)
    }
    // simple products are single cans
    for (const product of products) {
        if (product.type === "simple" && parsePrice(product)) pricesById.set(product.id, new Map([[1, parsePrice(product)]]))
    }

    const snus = products.flatMap((product): Snus[] => {
        const prices = [...pricesById.get(product.id) ?? []]
            .map(([pack, price]): [number, number] => [price, pack])
            .sort((a, b) => a[1] - b[1])
        if (!prices.length) return []

        const name = decodeEntities(product.name).trim()
        const text = descriptionText(product)
        const mgPerPouch = getMgPerPouch(name, text)
        if (!mgPerPouch || mgPerPouch > 100) return []

        const brand = getBrand(product, name)
        const smak = product.attributes?.find(a => a.taxonomy === "pa_smak")?.terms.map(t => t.name).join(" ")

        return [{
            vitt: product.categories.some(c => VITT_CATEGORIES.has(c.slug)),
            format: getFormat(product),
            brand,
            flavor: {
                broad: getBroadFlavor(smak, name),
                specific: extractSpecificFlavor(name, brand),
            },
            mgPerPouch,
            pouchesPerContainer: getPouches(text),
            prices,
            bestValue: getBestValue(prices),
            provider: "minprilla",
            url: product.permalink,
        }]
    })

    return {
        date: new Date(),
        provider: "minprilla",
        products: snus,
    }
}
