import express from 'express'
import { VERCEL, PORT } from './lib/env'
import { getTodaysResults } from './lib/cache'
import { filterAndSort, listBrands, listFlavors } from './lib/filterAndSort'
import { type AllData, PROVIDERS } from './types'
import cors from 'cors'

const app = express()
app.use(cors())

// today's data. when it isn't ready yet, responds 202 and returns null, and the client should retry in a minute
async function getResults(res: express.Response): Promise<AllData | null> {
    const results = await getTodaysResults()
    if (!results) {
        res.status(202)
        res.json({ ok: false, status: "aggregating", message: "Data is being aggregated. Check back in a minute." })
        return null
    }
    return results
}

app.get("/", async (req, res) => {
    const results = await getResults(res)
    if (!results) return

    const filtered = filterAndSort(results, req.query as any)
    res.json({ ok: true, date: results.date, products: filtered })
})

app.get("/brands", async (req, res) => {
    const results = await getResults(res)
    if (!results) return
    res.json({ ok: true, date: results.date, brands: listBrands(results) })
})

app.get("/flavors", async (req, res) => {
    const results = await getResults(res)
    if (!results) return
    res.json({ ok: true, date: results.date, flavors: listFlavors(results) })
})

// static, so it doesn't wait for today's data
app.get("/providers", (req, res) => {
    res.json({ ok: true, providers: PROVIDERS })
})

if (!VERCEL) {
    app.listen(PORT, () => {
        console.log(`Now listening on port ${PORT}.`)
    })
}

export default app