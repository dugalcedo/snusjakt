// other providers' flavors are free text in Swedish, so map them onto snusbolaget's broad flavors.
// first match wins, so the specific ones go before the generic ones ("enbär" before "bär")
const BROAD_FLAVORS: [string, string[]][] = [
    ["Juniper", ["enbär", "juniper"]],
    ["Liquorice", ["lakrits", "salmiak", "licorice", "liquorice"]],
    ["Cola", ["cola"]],
    ["Coffee", ["kaffe", "coffee", "mocha", "espresso", "cappuccino", "latte"]],
    ["Chili", ["chili", "jalapeño", "jalapeno", "habanero"]],
    ["Drink", ["whisky", "whiskey", "energy", "energi", "spritz", "mojito", "glögg", "drink", "läsk", "guarana"]],
    ["Mint", ["mint", "menthol", "mentol", "wintergreen", "mynta"]],
    ["Citrus", ["citrus", "citron", "lime", "lemon", "apelsin", "orange", "grapefrukt", "grapefruit", "bergamott", "bergamot", "yuzu", "pomelo", "kumquat"]],
    ["Berry", ["bär", "berry", "berries", "hallon", "jordgubb", "strawberry", "körsbär", "cherry", "lingon", "hjortron", "currant"]],
    ["Fruit", ["frukt", "fruit", "äpple", "apple", "melon", "mango", "persika", "peach", "päron", "pear", "ananas", "pineapple", "banan", "druva", "grape", "aprikos", "kiwi", "lychee", "passion", "tropical", "kaktus", "cactus"]],
    ["Spices", ["kanel", "cinnamon", "ingefära", "ginger", "vanilj", "vanilla", "peppar", "pepper", "kryddor"]],
    ["Traditional", ["traditionell", "tobak", "naturell", "original"]],
]

// smak first, since names like "Original Mint" would otherwise say Traditional
export function getBroadFlavor(smak: string | undefined, name: string): string {
    for (const source of [smak, name]) {
        const lower = source?.toLowerCase()
        if (!lower) continue
        const broad = BROAD_FLAVORS.find(([, keywords]) => keywords.some(keyword => lower.includes(keyword)))?.[0]
        if (broad) return broad
    }
    return "unknown"
}
