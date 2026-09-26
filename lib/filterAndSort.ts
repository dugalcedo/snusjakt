import * as T from "../types"

// ?. in case cached data is from before a provider was added
function allSnus(all: T.AllData): T.Snus[] {
    return T.PROVIDERS.flatMap(provider => all[provider]?.products ?? [])
}

// the brands and flavors filters are case-insensitive, so providers' spellings ("Skruf", "skruf") are one option.
// each option uses its most common spelling, sorted alphabetically
function listDistinct(values: string[]): string[] {
    const spellings = new Map<string, Map<string, number>>()
    for (const value of values) {
        const counts = spellings.get(value.toLowerCase()) ?? new Map<string, number>()
        counts.set(value, (counts.get(value) ?? 0) + 1)
        spellings.set(value.toLowerCase(), counts)
    }
    return [...spellings.values()]
        .map(counts => [...counts].sort((a, b) => b[1] - a[1])[0]![0])
        .sort((a, b) => a.localeCompare(b, 'sv'))
}

export function listBrands(all: T.AllData): string[] {
    return listDistinct(allSnus(all).map(s => s.brand))
}

// broad flavors, which is what the flavors filter matches. "unknown" isn't a flavor, so it's left out
export function listFlavors(all: T.AllData): string[] {
    return listDistinct(allSnus(all).map(s => s.flavor.broad).filter(f => f !== 'unknown'))
}

export function filterAndSort(all: T.AllData, _query: Record<string, string | undefined>): T.Snus[] {
    const query = processQuery(_query)

    let snus: T.Snus[] = allSnus(all)

    // ----- filter -----
    snus = snus.filter(s => {
        const isProvider = (
            query.providers.length === 0
            || query.providers.includes(s.provider)
        );

        const isInMgRange = (
            (s.mgPerPouch >= query.minMg)
            && (s.mgPerPouch <= query.maxMg)
        );

        const isType = (
            query.type === 'both'
            || (query.type === 'vitt' ? s.vitt : !s.vitt)
        );

        const isFlavor = (
            query.flavors.length === 0
            || query.flavors.includes(s.flavor.broad.toLowerCase())
        )

        const isBrand = (
            query.brands.length === 0
            || query.brands.includes(s.brand.toLowerCase())
        )

        return (
            isProvider
            && isInMgRange
            && isType
            && isFlavor
            && isBrand
        );
    })

    // ----- sort -----
    snus.sort((a, b) => {
        // sort by pack amount
        if (typeof query.sortBy === 'number') {
            const priceA = getMultipackPrice(a, query.sortBy)
            const priceB = getMultipackPrice(b, query.sortBy)
            return compareNumbers(priceA, priceB, query.order);
        }

        // sort by singular price
        if (query.sortBy === 'price') {
            const priceA = getMultipackPrice(a, 1)
            const priceB = getMultipackPrice(b, 1)
            return compareNumbers(priceA, priceB, query.order);
        }

        if (query.sortBy === 'mgPerPouch') {
            return compareNumbers(a.mgPerPouch, b.mgPerPouch, query.order);
        }

        // bestValue.price is the total for the whole pack, so compare per container instead
        return compareNumbers(a.bestValue.pricePerContainer, b.bestValue.pricePerContainer, query.order);
    })

    return snus
}

export function processQuery(query: Record<string, string | undefined>): T.Query {
// ---------- Query ----------
    const {
        /*
            if not provided, it's all
            comma separated, e.g. snusbolaget,someothercompany
        */
        providers,

        /*
            can be "mgPerPouch" or...
            "price1"/"price" = price of a single container
            "price5" = price of a 5-pack
            "price10" = price of a 10-pack
            etc...
            say it's price5, and a product doesn't have a 5-pack price, then we go by the container price * 5.
            sortBy can also be "bestvalue" to sort by, well the best value, whatever packaging that may be for a given product.
        */
        sortBy,

        // asc or desc, asc by default
        order,

        minMg,

        maxMg,

        /*
            Optional, comma-separated
        */
        brands,

        /*
            can be tobaks or vitt
            if left empty, it's both
        */
        type,

        /*
            comma separated, to search broadFlavors
        */
        flavors
    } = query

    return {
        providers: (!providers) ? [] : (providers.split(',').map(s => s.toLowerCase()) as T.Provider[]),
        sortBy: (() => {
            if (!sortBy) return 'price';
            const lower = sortBy.toLowerCase()
            if (lower === 'mgperpouch') return 'mgPerPouch'
            if (lower === 'bestvalue') return 'bestValue'
            if (lower === 'price') return 'price'
            if (!lower.startsWith('price')) return 'price'
            const number = parseInt(lower.slice(5))
            if (isNaN(number)) return 'price'
            return number
        })(),
        order: (order === 'desc') ? 'desc' : 'asc',
        minMg: (() => {
            if (typeof minMg != 'string') return 0
            let n = parseFloat(minMg)
            if (isNaN(n)) return 0
            return n
        })(),
        maxMg: (() => {
            if (typeof maxMg != 'string') return Infinity
            let n = parseFloat(maxMg)
            if (isNaN(n)) return Infinity
            return n
        })(),
        brands: (!brands) ? [] : brands.split(',').map(b => b.toLowerCase()),
        type: (() => {
            if (!type) return 'both'
            let t = type.toLowerCase()
            if (['vitt', 'tobaks', 'both'].includes(t)) return t as T.TypeKey
            return 'both'
        })(),
        flavors: (!flavors) ? [] : flavors.split(',').map(f => f.toLowerCase())
    }
}

// ----- helpers -----
function compareNumbers(a: number, b: number, order: 'asc' | 'desc'): number {
    if (a === b) return 0 // Infinity - Infinity is NaN, which breaks sort
    return order === 'asc' ? (a-b) : (b-a);
}

function getMultipackPrice(snus: T.Snus, packAmt: number): number {
    // prices are [price, pack], so flip them to look up by pack
    const map: Record<number, number> = Object.fromEntries(snus.prices.map(([price, pack]) => [pack, price]))
    const singlePrice = map[1] || Infinity // unknown prices should be sorted as if they are infinity
    const packPrice = map[packAmt]
    if (packPrice === undefined) return singlePrice * packAmt
    return packPrice || Infinity
}