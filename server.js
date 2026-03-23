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

/**
 * Search for a product on TCGPlayer by name
 * Returns product ID and basic info
 */
app.post('/api/search-tcgplayer', async (req, res) => {
    try {
          const { productName, category } = req.body;

      if (!productName) {
              return res.status(400).json({ error: 'Product name required' });
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

      const tcgCategory = categoryMap[category] || '';

      // Search TCGPlayer's public API
      const searchUrl = `https://api.tcgplayer.com/v1.39.0/products`;
          const params = {
                  q: productName,
                  limit: 10
          };

      if (tcgCategory) {
              params.categoryId = getCategoryId(tcgCategory);
      }

      const response = await axios.get(searchUrl, {
              params: params,
              headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
              },
              timeout: 5000
      });

      // Extract product info from response
      const results = response.data.results?.map(product => ({
              id: product.productId,
              name: product.productName,
              categoryId: product.categoryId,
              imageUrl: product.imageUrl,
              tcgplayerId: product.productId
      })) || [];

      res.json({
              success: true,
              results: results.slice(0, 5) // Return top 5 results
      });
    } catch (error) {
          console.error('TCGPlayer search error:', error.message);
          res.status(500).json({
                  success: false,
                  error: 'Failed to search TCGPlayer',
                  details: error.message
          });
    }
});

/**
 * Get live pricing for a specific product ID
 */
app.get('/api/tcgplayer-price/:productId', async (req, res) => {
    try {
          const { productId } = req.params;

      if (!productId) {
              return res.status(400).json({ error: 'Product ID required' });
      }

      // Check cache first
      if (priceCache[productId] && Date.now() - priceCache[productId].timestamp < CACHE_DURATION) {
              return res.json({
                        success: true,
                        price: priceCache[productId].price,
                        source: 'cache',
                        lastUpdated: priceCache[productId].timestamp
              });
      }

      // Fetch from TCGPlayer
      const pricingUrl = `https://api.tcgplayer.com/v1.39.0/products/${productId}/pricing`;

      const response = await axios.get(pricingUrl, {
              headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
              },
              timeout: 5000
      });

      // Extract market price
      const pricing = response.data.results?.[0];
          const marketPrice = pricing?.marketPrice || pricing?.midPrice || null;

      if (marketPrice === null) {
              return res.status(404).json({
                        success: false,
                        error: 'No pricing data available'
              });
      }

      // Cache the result
      priceCache[productId] = {
              price: marketPrice,
              timestamp: Date.now()
      };

      res.json({
              success: true,
              price: marketPrice,
              source: 'live',
              lastUpdated: Date.now(),
              productId: productId
      });
    } catch (error) {
          console.error('TCGPlayer pricing error:', error.message);
          res.status(500).json({
                  success: false,
                  error: 'Failed to fetch pricing from TCGPlayer',
                  details: error.message
          });
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
    res.json({ status: 'ok', timestamp: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Inventory tracker server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to access the tracker`);
});
