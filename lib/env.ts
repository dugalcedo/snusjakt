import 'dotenv/config'

// set automatically on vercel. there the app is imported instead of listened on, so PORT isn't needed
const VERCEL = !!process.env.VERCEL

const PORT = parseInt(process.env.PORT||"")

if (!VERCEL && (isNaN(PORT) || PORT < 1024 || PORT > 9999)) throw new Error(`invalid PORT in env-vars`)

export {
    VERCEL,
    PORT,
}