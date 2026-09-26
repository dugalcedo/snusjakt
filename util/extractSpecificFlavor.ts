const NOISE_WORDS = new Set([
    'strong', 'stark', 'extra', 'xtra', 'ultra', 'hyper', 'hypèr', 'intense', 'extremely', 'extreme', 'x-strong', 'low',
    'nikotinpåsar',
    'mini', 'slim', 'superslim', 'large', 'xtended',
    'white', 'vit', 'portion', 'portionssnus', 'lös', 'lössnus', 'one', 'plus',
])

// expects a decoded display name, e.g. "LOOP Red Chili Melon Hyper Strong 14,8mg" -> "Red Chili Melon"
export function extractSpecificFlavor(name: string, brand: string): string | undefined {
    let words = name
        .replace(/\d+(,\d+)?\s?mg\b/gi, '')
        .split(/\s+/)
        .filter(Boolean)

    // strip the brand word by word, since it doesn't always match exactly ("Lundgrens All White" vs "Lundgrens ...")
    const brandWords = brand.toLowerCase().split(/\s+/)
    let i = 0
    while (i < brandWords.length && words[i]?.toLowerCase() === brandWords[i]) i++
    words = words.slice(i)

    // drop "<anything> Edition", e.g. "Limited Edition", "Box Edition"
    words = words.filter((word, idx) => (
        word.toLowerCase() !== 'edition' &&
        words[idx + 1]?.toLowerCase() !== 'edition'
    ))

    words = words.filter(word => {
        const lower = word.toLowerCase()
        return !NOISE_WORDS.has(lower) &&
            !/^no\.\d+$/.test(lower) &&
            !/^[#s]\d+$/.test(lower) && // strength levels on snushandel, e.g. "#3", "s3"
            !/^\d+-pack$/.test(lower) &&
            !/^\d+$/.test(lower)
    })

    // "XQS The Menthol" -> "Menthol"
    if (words[0]?.toLowerCase() === 'the' && words.length > 1) words = words.slice(1)

    // only drop "Original" when something else remains, so "Kronan Original" stays "Original"
    const withoutOriginal = words.filter(word => word.toLowerCase() !== 'original')
    if (withoutOriginal.length) words = withoutOriginal

    return words.length ? words.join(' ') : undefined
}
