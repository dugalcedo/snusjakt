import { type Snus } from "../types"

// the pack with the lowest price per container. on a tie, the smaller pack wins, so prices should be sorted by pack size
export function getBestValue(prices: [number, number][]): Snus["bestValue"] {
    let best: Snus["bestValue"] | null = null
    for (const [price, amount] of prices) {
        const pricePerContainer = price / amount
        if (!best || pricePerContainer < best.pricePerContainer) {
            best = { amount, price, pricePerContainer }
        }
    }
    return best!
}
