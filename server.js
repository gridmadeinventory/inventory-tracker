const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory cache for pricing data
let priceCache = {};
const CACHE_DURATION = 3600000; // 1 hour in milliseconds

const TCG_API_BASE = 'https://api.tcgplayer.com/v1.39.0';
const TCG_TOKEN_URL = 'https://api.tcgplayer.com/token';

// TCGPlayer's API is OAuth-only: every catalog and pricing call needs a bearer
// token minted from a store's public/private key pair. Without them nothing
// here can work, so we say so plainly instead of falling through to a generic
// failure that looks like the product just has no price.
const TCG_PUBLIC_KEY = process.env.TCGPLAYER_PUBLIC_KEY;
const TCG_PRIVATE_KEY = process.env.TCGPLAYER_PRIVATE_KEY;

let tokenCache = null; // { token, expiresAt }

function hasCredentials() {
    return !!(TCG_PUBLIC_KEY && TCG_PRIVATE_KEY);
}

/**
 * Reject a request that cannot possibly succeed, with a message that says
 * what to do about it. Returns false when the caller should stop.
 */
function requireCredentials(res) {
    if (hasCredentials()) {
        return true;
    }

    res.status(503).json({
        success: false,
        code: 'missing_credentials',
        error: 'TCGPlayer API credentials are not configured on the server',
        details: 'Set TCGPLAYER_PUBLIC_KEY and TCGPLAYER_PRIVATE_KEY in your .env file, then restart. See .env.example.'
    });
    return false;
}

/**
 * Mint and cache a TCGPlayer bearer token
 */
async function getAccessToken() {
    if (tokenCache && Date.now() < tokenCache.expiresAt) {
        return tokenCache.token;
    }

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: TCG_PUBLIC_KEY,
        client_secret: TCG_PRIVATE_KEY
    });

    const response = await axios.post(TCG_TOKEN_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
    });

    const expiresIn = response.data.expires_in || 1209600; // seconds

    // Refresh a minute early so an in-flight request never uses a dead token
    tokenCache = {
        token: response.data.access_token,
        expiresAt: Date.now() + (expiresIn - 60) * 1000
    };

    return tokenCache.token;
}

/**
 * Authenticated GET against the TCGPlayer API
 */
async function tcgGet(path, params) {
    const token = await getAccessToken();

    return axios.get(`${TCG_API_BASE}${path}`, {
        params: params,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
        },
        timeout: 10000
    });
}

/**
 * Turn an upstream failure into something the UI can act on, rather than a
 * blanket 500 that reads as "no price exists"
 */
function respondWithUpstreamError(res, error, action) {
    const status = error.response?.status;

    console.error(`TCGPlayer ${action} error:`, status || '', error.message);

    if (status === 401 || status === 403) {
        // A rejected token is worth throwing away — the next call re-mints it
        tokenCache = null;
        return res.status(502).json({
            success: false,
            code: 'bad_credentials',
            error: 'TCGPlayer rejected the configured API credentials',
            details: 'Check TCGPLAYER_PUBLIC_KEY and TCGPLAYER_PRIVATE_KEY, and that the keys are approved for this API version.'
        });
    }

    res.status(502).json({
        success: false,
        code: 'upstream_error',
        error: `Failed to ${action} on TCGPlayer`,
        details: error.message
    });
}

/**
 * Search for a product on TCGPlayer by name
 * Returns product ID and basic info
 */
app.post('/api/search-tcgplayer', async (req, res) => {
    const { productName, category } = req.body;

    if (!productName) {
        return res.status(400).json({ success: false, error: 'Product name required' });
    }

    if (!requireCredentials(res)) {
        return;
    }

    // Map tracker categories to TCGPlayer categories
    const categoryMap = {
        'Sealed card products': 'Sealed Products',
        'Single cards': 'Single Cards',
        'Pins': 'Accessories',
        'Stickers': 'Accessories',
        'Playmats': 'Playmats',
        'Clothing': 'Apparel'
    };

    const params = {
        productName: productName,
        limit: 10
    };

    const categoryId = getCategoryId(categoryMap[category]);
    if (categoryId) {
        params.categoryId = categoryId;
    }

    try {
        const response = await tcgGet('/catalog/products', params);

        const results = response.data.results?.map(product => ({
            id: product.productId,
            name: product.name || product.productName,
            categoryId: product.categoryId,
            imageUrl: product.imageUrl,
            tcgplayerId: product.productId
        })) || [];

        res.json({
            success: true,
            results: results.slice(0, 5) // Return top 5 results
        });
    } catch (error) {
        respondWithUpstreamError(res, error, 'search');
    }
});

// The price tiers TCGPlayer reports for every printing. "market" is the one
// the tracker used to pull unconditionally — it tracks Near Mint sales, which
// is why every card came in at the same NM-ish number with no way to change it.
const PRICE_TIERS = ['market', 'low', 'mid', 'high', 'directLow'];

/**
 * Normalise one TCGPlayer pricing row into the tiers the UI offers.
 * TCGPlayer returns a row per printing (Normal, Foil, 1st Edition, ...),
 * each carrying the full set of tiers.
 */
function toVariant(row) {
    return {
        subTypeName: row.subTypeName || 'Normal',
        prices: {
            market: row.marketPrice ?? null,
            low: row.lowPrice ?? null,
            mid: row.midPrice ?? null,
            high: row.highPrice ?? null,
            directLow: row.directLowPrice ?? null
        }
    };
}

/**
 * Get live pricing for a specific product ID.
 * Returns every printing with every tier so the client can switch between
 * them without another round trip.
 */
app.get('/api/tcgplayer-price/:productId', async (req, res) => {
    const { productId } = req.params;

    if (!productId) {
        return res.status(400).json({ success: false, error: 'Product ID required' });
    }

    if (!requireCredentials(res)) {
        return;
    }

    // Check cache first
    const cached = priceCache[productId];
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return res.json({
            success: true,
            productId: productId,
            variants: cached.variants,
            source: 'cache',
            lastUpdated: cached.timestamp
        });
    }

    try {
        const response = await tcgGet(`/pricing/product/${productId}`);

        const variants = (response.data.results || [])
            .map(toVariant)
            .filter(variant => PRICE_TIERS.some(tier => variant.prices[tier] !== null));

        if (!variants.length) {
            return res.status(404).json({
                success: false,
                code: 'no_pricing',
                error: 'No pricing data available for this product'
            });
        }

        // Cache the result
        priceCache[productId] = {
            variants: variants,
            timestamp: Date.now()
        };

        res.json({
            success: true,
            productId: productId,
            variants: variants,
            source: 'live',
            lastUpdated: Date.now()
        });
    } catch (error) {
        respondWithUpstreamError(res, error, 'fetch pricing');
    }
});

/**
 * Map category names to TCGPlayer category IDs
 */
function getCategoryId(categoryName) {
    const categoryMap = {
        'Sealed Products': 1,
        'Single Cards': 2,
        'Playmats': 25,
        'Apparel': 26,
        'Accessories': 3
    };
    return categoryMap[categoryName] || '';
}

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        tcgplayerConfigured: hasCredentials(),
        timestamp: Date.now()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Inventory tracker server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to access the tracker`);

    if (!hasCredentials()) {
        console.warn('WARNING: TCGPLAYER_PUBLIC_KEY / TCGPLAYER_PRIVATE_KEY are not set.');
        console.warn('TCGPlayer search and live pricing will return a "not configured" error until they are.');
    }
});
