import { scrape as scrapeSnusbolaget } from './snusbolaget'
import { scrape as scrapeMinprilla } from './minprilla'
import { type AllData } from '../../types'

// snushandel is disabled for now (too slow), see DOC.md. to re-enable, add it back to _providerRecord in types.ts
// and scrape it here in parallel with the others
export async function scrapeAll(): Promise<AllData> {
    const [snusbolaget, minprilla] = await Promise.all([scrapeSnusbolaget(), scrapeMinprilla()])
    return {
        date: new Date(),
        snusbolaget,
        minprilla,
    }
}
