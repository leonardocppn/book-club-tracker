/**
 * Cloudflare Worker for Reading Progress Tracker
 * A collaborative system for book clubs to track reading progress
 */

// Authorized participants - customize this list for your group
const PARTICIPANTS = [
	"Alice",
	"Bob",
	"Charlie",
	"Diana",
	"Eve",
	"Frank",
	"Grace"
];

// Available emojis for participants
const AVAILABLE_EMOJIS = ["📚", "📖", "🦊", "🐻", "🦁", "🐼", "🦄"];

// Discord notification thresholds (optional)
const NOTIFICATION_THRESHOLDS = {
	50: (name) => `📚 **${name}** is halfway through the book!`,
	75: (name) => `💪 Great progress! **${name}** has reached 75% of the book!`,
	90: (name) => `🔥 **${name}** has reached 90%. Almost there!`
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// CORS headers to allow requests from any origin
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Content-Type': 'application/json'
		};

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// POST /initialize-reader - initialize a new reader with total pages
		if (request.method === 'POST' && url.pathname === '/initialize-reader') {
			try {
				const { name, totalPages, emoji } = await request.json();

				// Validate name
				if (!name || !PARTICIPANTS.includes(name)) {
					return new Response(JSON.stringify({
						error: 'Invalid name',
						allowedParticipants: PARTICIPANTS
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				// Validate totalPages
				if (!totalPages || !Number.isInteger(totalPages) || totalPages < 1 || totalPages > 9999) {
					return new Response(JSON.stringify({
						error: 'totalPages must be an integer between 1 and 9999'
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				// Validate emoji
				if (!emoji || !AVAILABLE_EMOJIS.includes(emoji)) {
					return new Response(JSON.stringify({
						error: 'Invalid emoji',
						availableEmojis: AVAILABLE_EMOJIS
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				// Check if already initialized
				const key = `reader:${name.toLowerCase()}`;
				const existing = await env.READING_DB.get(key, { type: 'json' });

				if (existing && existing.totalPages) {
					return new Response(JSON.stringify({
						error: 'Reader already initialized',
						reader: existing
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				// Check if emoji is already taken
				const promises = PARTICIPANTS.map(p => {
					const k = `reader:${p.toLowerCase()}`;
					return env.READING_DB.get(k, { type: 'json' });
				});
				const readers = await Promise.all(promises);
				const emojiAlreadyUsed = readers.find(r => r && r.emoji === emoji);

				if (emojiAlreadyUsed) {
					return new Response(JSON.stringify({
						error: 'Emoji already chosen by another participant',
						chosenBy: emojiAlreadyUsed.name
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				// Create new reader
				const reader = {
					name,
					totalPages,
					currentPage: 0,
					percentage: 0,
					emoji,
					startDate: new Date().toISOString(),
					lastUpdate: new Date().toISOString()
				};

				// Save to KV
				await env.READING_DB.put(key, JSON.stringify(reader));

				return new Response(JSON.stringify({
					ok: true,
					reader
				}), { headers: corsHeaders });

			} catch (error) {
				return new Response(JSON.stringify({
					error: 'Error saving data',
					details: error.message
				}), {
					status: 500,
					headers: corsHeaders
				});
			}
		}

		// POST /update-progress - update current page for a reader
		if (request.method === 'POST' && url.pathname === '/update-progress') {
			try {
				const { name, currentPage } = await request.json();

				// Validate name
				if (!name || !PARTICIPANTS.includes(name)) {
					return new Response(JSON.stringify({
						error: 'Invalid name',
						allowedParticipants: PARTICIPANTS
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				// Validate currentPage
				if (currentPage === undefined || currentPage === null || !Number.isInteger(currentPage) || currentPage < 0) {
					return new Response(JSON.stringify({
						error: 'currentPage must be an integer >= 0'
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				// Get existing reader
				const key = `reader:${name.toLowerCase()}`;
				const reader = await env.READING_DB.get(key, { type: 'json' });

				if (!reader || !reader.totalPages) {
					return new Response(JSON.stringify({
						error: 'Reader not initialized. Use /initialize-reader first'
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				// Clamp currentPage if it exceeds totalPages
				const effectivePage = Math.min(currentPage, reader.totalPages);

				// Save old percentage for threshold check
				const oldPercentage = reader.percentage || 0;

				// Calculate percentage
				const percentage = calculatePercentage(effectivePage, reader.totalPages);

				// Update reader
				reader.currentPage = effectivePage;
				reader.percentage = percentage;
				reader.lastUpdate = new Date().toISOString();

				// Check thresholds and send Discord notifications (if webhook configured)
				const newThresholdsNotified = await checkThresholdsAndNotify(
					reader,
					oldPercentage,
					percentage,
					env.DISCORD_WEBHOOK
				);

				// Update notified thresholds
				if (newThresholdsNotified.length > 0) {
					reader.thresholdsNotified = [
						...(reader.thresholdsNotified || []),
						...newThresholdsNotified
					];
				}

				// Save update
				await env.READING_DB.put(key, JSON.stringify(reader));

				return new Response(JSON.stringify({
					ok: true,
					reader,
					percentage
				}), { headers: corsHeaders });

			} catch (error) {
				return new Response(JSON.stringify({
					error: 'Error updating progress',
					details: error.message
				}), {
					status: 500,
					headers: corsHeaders
				});
			}
		}

		// GET /progress - get all progress data
		if (request.method === 'GET' && url.pathname === '/progress') {
			try {
				// Get all readers in parallel
				const promises = PARTICIPANTS.map(name => {
					const key = `reader:${name.toLowerCase()}`;
					return env.READING_DB.get(key, { type: 'json' });
				});

				const results = await Promise.all(promises);

				// Filter only initialized readers and sort by percentage descending
				const readers = results
					.filter(r => r !== null && r.totalPages !== undefined)
					.sort((a, b) => b.percentage - a.percentage);

				return new Response(JSON.stringify({
					readers,
					totalParticipants: PARTICIPANTS.length,
					active: readers.length
				}), { headers: corsHeaders });

			} catch (error) {
				return new Response(JSON.stringify({
					error: 'Error fetching progress',
					details: error.message
				}), {
					status: 500,
					headers: corsHeaders
				});
			}
		}

		// GET /available-emojis - get available and taken emojis
		if (request.method === 'GET' && url.pathname === '/available-emojis') {
			try {
				// Get all readers
				const promises = PARTICIPANTS.map(name => {
					const key = `reader:${name.toLowerCase()}`;
					return env.READING_DB.get(key, { type: 'json' });
				});

				const readers = await Promise.all(promises);

				// Find used emojis
				const usedEmojis = readers
					.filter(r => r !== null && r.emoji)
					.map(r => r.emoji);

				// Create emoji list with availability status
				const emojisWithStatus = AVAILABLE_EMOJIS.map(emoji => ({
					emoji,
					available: !usedEmojis.includes(emoji),
					usedBy: usedEmojis.includes(emoji)
						? readers.find(r => r && r.emoji === emoji)?.name
						: null
				}));

				return new Response(JSON.stringify({
					emojis: emojisWithStatus,
					total: AVAILABLE_EMOJIS.length,
					available: emojisWithStatus.filter(e => e.available).length
				}), { headers: corsHeaders });

			} catch (error) {
				return new Response(JSON.stringify({
					error: 'Error fetching emojis',
					details: error.message
				}), {
					status: 500,
					headers: corsHeaders
				});
			}
		}

		// POST /reset-reader - reset reader data (admin)
		if (request.method === 'POST' && url.pathname === '/reset-reader') {
			try {
				const { name, field } = await request.json();

				// Validate name
				if (!name || !PARTICIPANTS.includes(name)) {
					return new Response(JSON.stringify({
						error: 'Invalid name',
						allowedParticipants: PARTICIPANTS
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				// Validate field
				const validFields = ['all', 'progress', 'totalPages'];
				if (!field || !validFields.includes(field)) {
					return new Response(JSON.stringify({
						error: 'Invalid field',
						allowedFields: validFields
					}), {
						status: 400,
						headers: corsHeaders
					});
				}

				const key = `reader:${name.toLowerCase()}`;

				if (field === 'all') {
					// Complete reset - delete everything
					await env.READING_DB.delete(key);
					return new Response(JSON.stringify({
						ok: true,
						message: `Reader ${name} completely reset`
					}), { headers: corsHeaders });
				}

				// For partial resets, get existing reader
				const reader = await env.READING_DB.get(key, { type: 'json' });

				if (!reader) {
					return new Response(JSON.stringify({
						error: 'Reader not found'
					}), {
						status: 404,
						headers: corsHeaders
					});
				}

				if (field === 'progress') {
					// Reset only progress
					reader.currentPage = 0;
					reader.percentage = 0;
					reader.lastUpdate = new Date().toISOString();
				} else if (field === 'totalPages') {
					// Reset total pages (keeps structure)
					delete reader.totalPages;
					reader.currentPage = 0;
					reader.percentage = 0;
					reader.lastUpdate = new Date().toISOString();
				}

				await env.READING_DB.put(key, JSON.stringify(reader));

				return new Response(JSON.stringify({
					ok: true,
					reader,
					message: `Field ${field} reset for ${name}`
				}), { headers: corsHeaders });

			} catch (error) {
				return new Response(JSON.stringify({
					error: 'Error resetting',
					details: error.message
				}), {
					status: 500,
					headers: corsHeaders
				});
			}
		}

		// Root - API info
		if (url.pathname === '/') {
			return new Response(JSON.stringify({
				name: 'Reading Progress Tracker API',
				description: 'A collaborative reading progress tracker for book clubs',
				participants: PARTICIPANTS,
				availableEmojis: AVAILABLE_EMOJIS,
				endpoints: {
					'POST /initialize-reader': 'Initialize reader { name, totalPages, emoji }',
					'POST /update-progress': 'Update progress { name, currentPage }',
					'GET /progress': 'Get all progress data',
					'GET /available-emojis': 'Get available emojis and their status',
					'POST /reset-reader': 'Reset reader data { name, field: "all"|"progress"|"totalPages" }'
				}
			}, null, 2), { headers: corsHeaders });
		}

		return new Response('Not found', { status: 404, headers: corsHeaders });
	}
};

/**
 * Calculate completion percentage
 * @param {number} current - Current page
 * @param {number} total - Total pages
 * @returns {number} Percentage with 2 decimal places
 */
function calculatePercentage(current, total) {
	if (total === 0) return 0;
	return Math.round((current / total) * 10000) / 100;
}

/**
 * Check and send Discord notifications for crossed thresholds
 * @param {object} reader - Reader object
 * @param {number} oldPercentage - Percentage before update
 * @param {number} newPercentage - Percentage after update
 * @param {string} webhookUrl - Discord webhook URL
 * @returns {Promise<number[]>} Array of notified thresholds
 */
async function checkThresholdsAndNotify(reader, oldPercentage, newPercentage, webhookUrl) {
	if (!webhookUrl) return [];

	const thresholdsNotified = [];
	const alreadyNotified = reader.thresholdsNotified || [];

	for (const [threshold, generateMessage] of Object.entries(NOTIFICATION_THRESHOLDS)) {
		const thresholdNum = parseInt(threshold);

		// If crossed threshold and not already notified
		if (newPercentage >= thresholdNum && !alreadyNotified.includes(thresholdNum)) {
			try {
				await fetch(webhookUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						content: generateMessage(reader.name)
					})
				});
				thresholdsNotified.push(thresholdNum);
			} catch (error) {
				console.error(`Error sending Discord notification for threshold ${thresholdNum}:`, error);
			}
		}
	}

	return thresholdsNotified;
}
