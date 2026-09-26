import { type ProductScraper, type Snus } from "../../types"
import { extractSpecificFlavor } from "../../util/extractSpecificFlavor"
import { mapLimited } from "../../util/mapLimited"
import { getBestValue } from "../../util/getBestValue"

const VITTSNUS_URL = "https://www.snusbolaget.se/vitt-snus"
const TOBAKSSNUS_URL = "https://www.snusbolaget.se/tobakssnus"
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
}
const PRODUCT_PAGE_CONCURRENCY = 10

// what snusbolaget puts in window.EasyfyEventLayer.products, keyed by product id
type EventLayerProduct = {
    DisplayName: string
    Brand: string
    Flavour?: string
    Format?: string
    AbsoluteProductUrl: string
}

type ListingProduct = EventLayerProduct & {
    id: string
    vitt: boolean
    prices: [number, number][]
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) throw new Error(`snusbolaget: ${res.status} for ${url}`)
    return res.text()
}

// "1&#xA0;499,90 kr" -> 1499.9 (HTMLRewriter doesn't decode entities, so drop them before the digits get mixed in)
function parseSwedishNumber(text: string): number {
    return parseFloat(text.replace(/&#?\w+;/g, "").replace(/[^\d,]/g, "").replace(",", "."))
}

function parseMgFromName(name: string): number | undefined {
    const match = name.match(/(\d+(?:,\d+)?)\s?mg\b/i)
    return match ? parseSwedishNumber(match[1]!) : undefined
}

async function parseListingPage(html: string, vitt: boolean): Promise<ListingProduct[]> {
    const layerJson = html.match(/window\.EasyfyEventLayer = (\{.*\})\s*;?\s*$/m)?.[1]
    if (!layerJson) throw new Error("snusbolaget: couldn't find EasyfyEventLayer")
    const layer: Record<string, EventLayerProduct> = JSON.parse(layerJson).products

    const cards: { id: string, prices: Map<number, number> }[] = []
    let card: typeof cards[number] | null = null
    let packSize: number | null = null
    let priceText = ""

    await new HTMLRewriter()
        .on('li[data-container="product-card"]', {
            element(el) {
                // promo shelves repeat products from elsewhere, so only the regular category list counts
                if (el.getAttribute("data-event-property-is-promotion") === "True") {
                    card = null
                    return
                }
                card = { id: el.getAttribute("data-product-event-id")!, prices: new Map() }
                cards.push(card)
                el.onEndTag(() => { card = null })
            }
        })
        .on('li[data-container="product-card"] label[data-container="salesunit-option"]', {
            element(el) {
                // data-salesunitcode is e.g. "10P". price type can be BasePrice, CampaignPrice or UpsellPrice,
                // and all of them are real prices (UpsellPrice is e.g. a 14,90 kr 1-pack offer, and is sometimes the only 1-pack price)
                packSize = parseInt(el.getAttribute("data-salesunitcode") ?? "")
            }
        })
        .on('li[data-container="product-card"] label[data-container="salesunit-option"] [data-container="price"]', {
            text(chunk) {
                priceText += chunk.text
                if (!chunk.lastInTextNode) return
                if (card && packSize) card.prices.set(packSize, parseSwedishNumber(priceText))
                priceText = ""
            }
        })
        .transform(new Response(html))
        .text()

    return cards.flatMap(({ id, prices }) => {
        const product = layer[id]
        if (!product) return []
        return [{
            ...product,
            id,
            vitt,
            prices: [...prices]
                .map(([pack, price]): [number, number] => [price, pack])
                .sort((a, b) => a[1] - b[1]),
        }]
    })
}

async function scrapeCategory(url: string, vitt: boolean): Promise<ListingProduct[]> {
    const firstPage = await fetchText(url)
    const totalPages = parseInt(firstPage.match(/data-total-pages="(\d+)"/)?.[1] ?? "1")

    const otherPages = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) => fetchText(`${url}?p=${i + 2}`))
    )

    const pages = await Promise.all([firstPage, ...otherPages].map(html => parseListingPage(html, vitt)))
    return pages.flat()
}

type ProductPageInfo = {
    mgPerPouch?: number
    pouchesPerContainer?: number
}

// reads the product page's JSON-LD. mg is in additionalProperty, but the pouch count is only in the description,
// e.g. "Antal prillor per dosa: 20 st" or "Antal prillor per förpackning: 500 st" for bulk bags
async function fetchProductPageInfo(url: string): Promise<ProductPageInfo> {
    try {
        const html = await fetchText(url)
        for (const [, json] of html.matchAll(/<script type="application\/ld(?:\+|&#x2B;)json">([\s\S]*?)<\/script>/g)) {
            const data = JSON.parse(json!)
            if (data["@type"] !== "Product") continue
            const mg = data.additionalProperty
                ?.find((prop: { name: string }) => prop.name === "Nikotinhalt (mg/portion)")
                ?.value
            const pouches = String(data.description ?? "").match(/Antal prillor per \S+: (\d+)/)?.[1]
            return {
                mgPerPouch: mg ? parseSwedishNumber(String(mg)) : undefined,
                pouchesPerContainer: pouches ? parseInt(pouches) : undefined,
            }
        }
    } catch (err) {
        console.error(err)
    }
    return {}
}

export const scrape: ProductScraper = async () => {
    const listings = (await Promise.all([
        scrapeCategory(VITTSNUS_URL, true),
        scrapeCategory(TOBAKSSNUS_URL, false),
    ])).flat()

    // dedupe in case a product shows up in both categories, and skip lös snus since it has no pouches
    const unique = [...new Map(listings.map(product => [product.id, product])).values()]
        .filter(product => product.Format !== "Loose" && product.prices.length)

    const products = await mapLimited(unique, PRODUCT_PAGE_CONCURRENCY, async (product): Promise<Snus | null> => {
        // tobakssnus names usually don't include mg, so those fall back to the product page.
        // that's also where bulk bags (300-500 pouches) come from, since their names don't have mg either
        const mgFromName = parseMgFromName(product.DisplayName)
        const pageInfo = mgFromName ? {} : await fetchProductPageInfo(product.AbsoluteProductUrl)
        const mgPerPouch = mgFromName ?? pageInfo.mgPerPouch
        if (!mgPerPouch) return null

        return {
            vitt: product.vitt,
            format: product.Format,
            brand: product.Brand,
            flavor: {
                broad: product.Flavour ?? "unknown",
                specific: extractSpecificFlavor(product.DisplayName, product.Brand),
            },
            mgPerPouch,
            pouchesPerContainer: pageInfo.pouchesPerContainer,
            prices: product.prices,
            bestValue: getBestValue(product.prices),
            provider: "snusbolaget",
            url: product.AbsoluteProductUrl,
        }
    })

    return {
        date: new Date(),
        provider: "snusbolaget",
        products: products.filter((product): product is Snus => product !== null),
    }
}
