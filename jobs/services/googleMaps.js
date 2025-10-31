import axios from 'axios';

// Google Maps API key - should be stored in environment variables in production
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Search for places by name and location
 * @param {string} query - The place name to search for
 * @param {string} location - The town/city name or coordinates
 * @param {number} radius - Search radius in meters (default: 5000)
 * @returns {Promise<Array>} - Array of place results
 */
export async function searchPlacesByName(query, location, radius = 5000) {
  try {
    console.log('searchPlacesByName called with:', { query, location, radius });
    
    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error('Google Maps API key is not configured. Please set the GOOGLE_MAPS_API_KEY environment variable.');
    }

    // First get coordinates from location if not provided as lat,lng
    let locationCoords = location;
    if (!location.includes(',')) {
      console.log(`Location "${location}" is not in lat,lng format, geocoding...`);
      const geocodeResult = await geocodeLocation(location);
      if (geocodeResult) {
        locationCoords = `${geocodeResult.lat},${geocodeResult.lng}`;
        console.log(`Successfully geocoded to: ${locationCoords}`);
      } else {
        console.error(`Failed to geocode location: ${location}`);
        throw new Error('Could not geocode location. Please provide a valid location name or coordinates.');
      }
    } else {
      console.log(`Using provided coordinates: ${locationCoords}`);
    }

    // Build request URL for logging (with masked API key)
    const requestUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=${encodeURIComponent(locationCoords)}&radius=${radius}&key=${GOOGLE_MAPS_API_KEY.substring(0, 3)}...`;
    console.log('Place search request:', requestUrl);

    const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: {
        query,
        location: locationCoords,
        radius,
        key: GOOGLE_MAPS_API_KEY
      }
    });

    console.log('Place search response status:', response.data.status);
    console.log(`Found ${response.data.results?.length || 0} results`);
    
    if (response.data.status === 'REQUEST_DENIED') {
      console.error('Google Maps API request denied:', response.data.error_message);
      throw new Error(`Google Maps API request denied: ${response.data.error_message}`);
    }

    if (!response.data.results || response.data.results.length === 0) {
      console.log('No places found for query:', query);
    }

    return response.data.results;
  } catch (error) {
    console.error('Error searching places by name:', error);
    throw error;
  }
}

/**
 * Search nearby competitors using a list of keywords and rank by distance.
 * @param {string[]} keywords - List of keywords (e.g., from GPT)
 * @param {string} locationCoords - 'lat,lng' format (e.g., '37.7749,-122.4194')
 * @param {string} excludePlaceId - Place ID of the original business to exclude
 * @param {number} maxResults - Maximum number of competitors to return (default 5)
 * @returns {Promise<Array>} - List of closest competitors
 */
export async function generateCompetitorListByKeywords(keywords, locationCoords, excludePlaceId, maxResults = 5) {
  try {
    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error('Google Maps API key is not configured.');
    }

    let allResults = [];

    for (const keyword of keywords) {
      const response = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: {
          location: locationCoords,
          rankby: 'distance',
          keyword: keyword,
          key: GOOGLE_MAPS_API_KEY
        }
      });

      if (response.data && response.data.results) {
        allResults.push(...response.data.results);
      }
    }

    // Remove duplicates (places might show up in multiple keyword searches)
    const uniqueResults = new Map();
    allResults.forEach(place => {
      if (!uniqueResults.has(place.place_id)) {
        uniqueResults.set(place.place_id, place);
      }
    });

    // Convert to array, filter out the original place
    let competitors = Array.from(uniqueResults.values())
      .filter(place => place.place_id !== excludePlaceId);

    // Sort by number of ratings first (more popular) then rating
    competitors = competitors.sort((a, b) => {
      if ((b.user_ratings_total || 0) !== (a.user_ratings_total || 0)) {
        return (b.user_ratings_total || 0) - (a.user_ratings_total || 0);
      }
      return (b.rating || 0) - (a.rating || 0);
    }).slice(0, maxResults);

    return competitors.map(place => ({
      name: place.name,
      address: place.vicinity,
      rating: place.rating || null,
      userRatingsTotal: place.user_ratings_total || 0,
      priceLevel: place.price_level ?? null,
      placeId: place.place_id,
      googleMapsUrl: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`
    }));

  } catch (error) {
    console.error('Error finding competitors by keywords:', error);
    throw error;
  }
}

/**
 * Get detailed information about a place including reviews
 * @param {string} placeId - The Google Maps Place ID
 * @returns {Promise<Object>} - Detailed place information
 */
export async function getPlaceDetails(placeId) {
  try {
    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error('Google Maps API key is not configured. Please set the GOOGLE_MAPS_API_KEY environment variable.');
    }

    const response = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id: placeId,
        fields: 'name,rating,reviews,formatted_address,formatted_phone_number,opening_hours,website,price_level,types,geometry,url',
        key: GOOGLE_MAPS_API_KEY
      }
    });

    console.log(`Place details response for ${placeId}:`, JSON.stringify(response.data.result));

    if (response.data.status === 'REQUEST_DENIED') {
      console.error('Google Maps API request denied:', response.data.error_message);
      throw new Error(`Google Maps API request denied: ${response.data.error_message}`);
    }

    return response.data.result;
  } catch (error) {
    console.error('Error getting place details:', error);
    throw error;
  }
}

/**
 * Generate a competitive analysis report for a business category in a location
 * @param {string} businessName - The target business name
 * @param {string} category - The business category
 * @param {string} location - The town/city name or coordinates
 * @param {number} radius - Search radius in meters (default: 5000)
 * @returns {Promise<Object>} - Business report with competitive analysis
 */
export async function generateBusinessReport(businessName, category, location, radius = 5000) {
    try {
      // Normalize location to coordinates
      let locationCoords = location;
      const latLngPattern = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
      if (!latLngPattern.test(location)) {
        const geocodeResult = await geocodeLocation(location);
        if (geocodeResult) {
          locationCoords = `${geocodeResult.lat},${geocodeResult.lng}`;
        } else {
          throw new Error('Could not geocode location');
        }
      }
  
      // Find the target business
      const targetBusinessResults = await searchPlacesByName(`${businessName}`, locationCoords, radius);
      if (!targetBusinessResults || targetBusinessResults.length === 0) {
        throw new Error('Target business not found');
      }
  
      const targetBusiness = targetBusinessResults[0];
      const targetBusinessDetails = await getPlaceDetails(targetBusiness.place_id);
  
      // Find competitors in the same category
      const competitors = await searchBusinessesByCategory(category, locationCoords, radius);
  
      const topCompetitors = competitors
        .filter(comp => comp.place_id !== targetBusiness.place_id)
        .sort((a, b) => (b.rating || 0) - (a.rating || 0))
        .slice(0, 5);
  
      const competitorDetails = await Promise.all(
        topCompetitors.map(comp => getPlaceDetails(comp.place_id))
      );
  
      const avgRating = competitorDetails.reduce((sum, comp) => sum + (comp.rating || 0), 0) / competitorDetails.length;
  
      return {
        targetBusiness: targetBusinessDetails,
        marketOverview: {
          totalCompetitors: competitors.length - 1,
          averageRating: avgRating,
          topCompetitors: competitorDetails.map(comp => ({
            name: comp.name,
            address: comp.formatted_address,
            rating: comp.rating,
            reviews: comp.reviews?.map(review => ({
              author: review.author_name,
              rating: review.rating,
              text: review.text,
              time: review.time,
              relativeTime: review.relative_time_description
            })) || [],
            totalReviews: comp.reviews?.length || 0,
            priceLevel: comp.price_level
          }))
        },
        newCompetition: competitorDetails
          .filter(comp => comp.rating > 4.0)
          .map(comp => ({
            name: comp.name,
            address: comp.formatted_address,
            rating: comp.rating,
            reviews: comp.reviews?.map(review => ({
              author: review.author_name,
              rating: review.rating,
              text: review.text,
              time: review.time,
              relativeTime: review.relative_time_description
            })) || [],
            totalReviews: comp.reviews?.length || 0
          }))
      };
    } catch (error) {
      console.error('Error generating business report:', error);
      throw error;
    }
}  

/**
 * Helper function to geocode a location name to coordinates
 * @param {string} locationName - Name of the location to geocode
 * @returns {Promise<Object>} - Object with lat and lng properties
 */
async function geocodeLocation(locationName) {
  try {
    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error('Google Maps API key is not configured. Please set the GOOGLE_MAPS_API_KEY environment variable.');
    }

    // Build the geocoding URL for logging
    const geocodingUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(locationName)}&key=${GOOGLE_MAPS_API_KEY.substring(0, 3)}...`;
    console.log('Geocoding request:', geocodingUrl);
    
    // Make the actual request
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: locationName,
        key: GOOGLE_MAPS_API_KEY
      }
    });

    // Log full response for debugging
    console.log('Geocoding response status:', response.data.status);
    console.log('Geocoding response:', JSON.stringify(response.data));

    if (response.data.status === 'REQUEST_DENIED') {
      console.error('Google Maps API request denied:', response.data.error_message);
      throw new Error(`Google Maps API request denied: ${response.data.error_message}`);
    }

    if (response.data.results && response.data.results.length > 0) {
      return response.data.results[0].geometry.location;
    }
    
    console.error('No geocoding results found for:', locationName);
    return null;
  } catch (error) {
    console.error('Error geocoding location:', error);
    throw error;
  }
} 