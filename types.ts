const _providerRecord = {
    snusbolaget: true,
    minprilla: true,
    // snushandel: true, // disabled, too slow. see DOC.md
}

export type Provider = keyof typeof _providerRecord

export const PROVIDERS = Object.keys(_providerRecord) as Provider[]


export type Snus = {
    vitt?: boolean // assumed to be false (tobakssnus)
    format?: string // assumed to be normal/medium. could be "thin", "loose", "superthin", etc..
    brand: string
    flavor: {
        broad: string
        specific?: string
    }
    mgPerPouch: number
    pouchesPerContainer?: number
    prices: [number, number][] // e.g. [309.9, 10] means 309,90 SEK for a 10-pack
    provider: Provider
    url: string
    bestValue: { // e.g. { amount: 5, price: 150.0, pricePerContainer: 30.0 } would mean a 5-pack costs 150 kr
        amount: number
        price: number
        pricePerContainer: number
    }
}

export type ProductScraperInput = {
    
}

export type ProductScraperResult = {
    date: Date
    provider: Provider
    products: Snus[]
}

export type ProductScraper = (input?: ProductScraperInput) => Promise<ProductScraperResult>

export type AllData = Record<Provider, ProductScraperResult> & { date: Date }

export type SortKey = 'mgPerPouch' | 'bestValue' | 'price' | number
export type TypeKey = 'tobaks' | 'vitt' | 'both'

export type Query = {
    providers: Provider[]
    sortBy: SortKey 
    order: 'asc' | 'desc'
    minMg: number
    maxMg: number
    brands: string[]
    type: TypeKey
    flavors: string[]
}