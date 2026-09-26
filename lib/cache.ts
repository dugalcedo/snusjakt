import { list, put } from "@vercel/blob";
import { waitUntil } from "@vercel/functions";
import { PROVIDERS, type AllData } from "../types";
import { scrapeAll } from "./scrapers";

const BLOB_PATH = "snus.json"
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000 // so a provider being down doesn't get every request re-scraping

// locally there's usually no blob token, so data only lives in memory
const HAS_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN

let memory: AllData | null = null
let aggregating: Promise<void> | null = null
let lastFailedAt = 0

// today's data, or null when it isn't ready yet. in that case this starts aggregating it in the background
export async function getTodaysResults(): Promise<AllData | null> {
    if (memory && isToday(memory.date)) return memory
    if (aggregating) return null

    // another instance may have aggregated today already
    const stored = await readBlob()
    if (stored) memory = stored
    if (stored && isToday(stored.date)) return stored

    startAggregating()
    return null
}

function startAggregating(): void {
    if (aggregating || Date.now() - lastFailedAt < RETRY_AFTER_FAILURE_MS) return
    aggregating = scrapeAll()
        .then(writeResults)
        .catch(err => {
            lastFailedAt = Date.now()
            console.error("aggregating failed", err)
        })
        .finally(() => { aggregating = null })
    // on vercel, keeps the function alive after the response is sent
    waitUntil(aggregating)
}

// "today" in Sweden, since that's where the prices are
function isToday(date: Date): boolean {
    const day = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" })
    return day(date) === day(new Date())
}

async function readBlob(): Promise<AllData | null> {
    if (!HAS_BLOB) return null
    try {
        const { blobs } = await list({ prefix: BLOB_PATH, limit: 1 })
        const blob = blobs.find(b => b.pathname === BLOB_PATH)
        if (!blob) return null

        // blob urls are cdn-cached, so bust it to make sure we get the latest
        const res = await fetch(`${blob.url}?t=${Date.now()}`)
        if (!res.ok) return null
        return reviveDates(await res.json())
    } catch (err) {
        console.error(err)
        return null
    }
}

async function writeResults(data: AllData): Promise<void> {
    memory = data
    if (!HAS_BLOB) return
    await put(BLOB_PATH, JSON.stringify(data), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: 60,
    })
}

// dates come back from JSON as strings
function reviveDates(raw: any): AllData {
    const data = { ...raw, date: new Date(raw.date) }
    for (const provider of PROVIDERS) {
        if (data[provider]) data[provider] = { ...data[provider], date: new Date(data[provider].date) }
    }
    return data
}
