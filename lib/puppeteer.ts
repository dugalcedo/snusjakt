import puppeteer, { type Browser } from "puppeteer";

let browser: Browser | null = null

export async function getBrowser(): Promise<Browser> {
    if (browser) return browser
    browser = await puppeteer.launch()
    return browser
}
