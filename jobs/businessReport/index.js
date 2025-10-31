import express from 'express';
import { generateCompetitorKeywords } from './competitorKeywords.js';
import * as GoogleMaps from '../services/googleMaps.js';
import { scrapeGoogleReviews } from '../services/googleReviews.js';
import fetch from 'node-fetch';

const router = express.Router();

// STEP 1: Generate keywords + competitors
router.post('/generate-keywords', async (req, res) => {
  try {
    const { placeId } = req.body;
    if (!placeId) throw new Error('Missing placeId');

    const businessInfo = await GoogleMaps.getPlaceDetails(placeId);

    const keywords = await generateCompetitorKeywords({
      name: businessInfo.name,
      types: businessInfo.types,
      description: businessInfo.editorial_summary?.overview || ''
    });

    const { lat, lng } = businessInfo.geometry.location;
    const coords = `${lat},${lng}`;
    const competitors = await GoogleMaps.generateCompetitorListByKeywords(keywords, coords);

    res.json({
      businessInfo,
      keywords,
      competitors
    });
  } catch (error) {
    console.error('Error generating keywords:', error);
    res.status(500).json({ error: error.message });
  }
});

// STEP 2: Scrape reviews
router.post('/scrape-reviews', async (req, res) => {
  try {
    const { placeId } = req.body;
    if (!placeId) throw new Error('Missing placeId');

    const googleMapsUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}`

    let reviews = [];

    if (googleMapsUrl) {
      try {
        const scrapedReviews = await scrapeGoogleReviews(googleMapsUrl, { scrollCount: 2 });
        reviews = scrapedReviews;
      } catch (err) {
        console.error(`Error scraping competitor ${placeId}:`, err);
        throw err;
      }
    }

    res.json({
      reviews
    });
  } catch (error) {
    console.error('Error scraping reviews:', error);
    res.status(500).json({ error: error.message });
  }
});

// STEP 3: Analyze and finalize report
router.post('/analyze-report', async (req, res) => {
  try {
    const { businessInfo, reviews, competitors } = req.body;
    if (!businessInfo || !reviews || !competitors) {
      throw new Error('Missing required analysis input');
    }

    const report = {
      businessInfo,
      reviews,
      marketAnalysis: {
        totalCompetitors: competitors.length,
        topCompetitors: competitors
      }
    };

    const pythonApiBase = process.env.PYTHON_API || 'http://localhost:8080';
    const pythonUrl = `${pythonApiBase}/business/analyze-business`;

    try {
      const response = await fetch(pythonUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetBusiness: report.businessInfo,
          reviews: report.reviews,
          marketOverview: {
            topCompetitors: report.marketAnalysis.topCompetitors
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Python analysis error: ${errorText}`);
      }

      const analysis = await response.json();
      report.analysis = analysis;
    } catch (err) {
      console.error('Error calling Python service:', err);
      report.analysisError = 'Error connecting to Python service';
    }

    res.json(report);
  } catch (error) {
    console.error('Error analyzing report:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
