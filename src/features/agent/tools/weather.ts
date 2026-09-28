import { tool } from 'ai';
import { z } from 'zod';

/** Default span of the daily forecast; the model may widen it via `forecast_days`. */
const DEFAULT_FORECAST_DAYS = 3;

export interface WeatherDeps {
	/** Injected for tests; defaults to the global `fetch` at the call site. */
	fetch: typeof fetch;
}

/** WMO weather interpretation codes → human-readable text (Open-Meteo `weather_code`). */
const WMO: Record<number, string> = {
	0: 'Clear sky',
	1: 'Mainly clear',
	2: 'Partly cloudy',
	3: 'Overcast',
	45: 'Fog',
	48: 'Depositing rime fog',
	51: 'Light drizzle',
	53: 'Moderate drizzle',
	55: 'Dense drizzle',
	56: 'Light freezing drizzle',
	57: 'Dense freezing drizzle',
	61: 'Light rain',
	63: 'Moderate rain',
	65: 'Heavy rain',
	66: 'Light freezing rain',
	67: 'Heavy freezing rain',
	71: 'Light snow',
	73: 'Moderate snow',
	75: 'Heavy snow',
	77: 'Snow grains',
	80: 'Light rain showers',
	81: 'Moderate rain showers',
	82: 'Violent rain showers',
	85: 'Light snow showers',
	86: 'Heavy snow showers',
	95: 'Thunderstorm',
	96: 'Thunderstorm with light hail',
	99: 'Thunderstorm with heavy hail',
};

/** Render a WMO code to text, falling back to the raw number when unknown. */
function describe(code: number): string {
	return WMO[code] ?? `Code ${code}`;
}

interface GeoMatch {
	name: string;
	country_code?: string;
	latitude: number;
	longitude: number;
}

/**
 * **Weather tool** (`get_weather`, docs/adr/0022). Returns current conditions plus a
 * short daily forecast from **Open-Meteo** (keyless). City-first: a required
 * `location` string is resolved via Open-Meteo's geocoding endpoint (top match),
 * unless the model supplies `latitude`/`longitude`, which skip geocoding for
 * precision. `timezone=auto` and metric units. WMO `weather_code` values are
 * rendered to text (raw code kept). An unknown city is a normal outcome, not a
 * failure: it returns a soft `{ error }` so the model can ask the user to clarify.
 */
export function weatherTool(deps: WeatherDeps) {
	return tool({
		description:
			'Get the current weather and a short daily forecast for a place. Pass a city/location name; ' +
			'optionally pass latitude and longitude to skip geocoding. Metric units.',
		inputSchema: z.object({
			location: z.string().describe('City or place name, e.g. "Tokyo" or "Paris, France"'),
			latitude: z.number().optional().describe('Latitude; pass with longitude to skip geocoding'),
			longitude: z.number().optional().describe('Longitude; pass with latitude to skip geocoding'),
			forecast_days: z.number().int().min(1).max(16).optional().describe('Days of daily forecast (default 3)'),
		}),
		execute: async ({ location, latitude, longitude, forecast_days }) => {
			let resolvedName = location;
			let lat = latitude;
			let lon = longitude;

			// City path: geocode unless precise coordinates were supplied.
			if (lat === undefined || lon === undefined) {
				const match = await geocode(deps.fetch, location);
				if (!match) {
					return { error: `No location found for "${location}"` };
				}
				lat = match.latitude;
				lon = match.longitude;
				resolvedName = match.country_code ? `${match.name}, ${match.country_code}` : match.name;
			}

			const days = forecast_days ?? DEFAULT_FORECAST_DAYS;
			const url = new URL('https://api.open-meteo.com/v1/forecast');
			url.searchParams.set('latitude', String(lat));
			url.searchParams.set('longitude', String(lon));
			url.searchParams.set('timezone', 'auto');
			url.searchParams.set('forecast_days', String(days));
			url.searchParams.set(
				'current',
				'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation'
			);
			url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');

			const res = await deps.fetch(url.toString());
			if (!res.ok) {
				throw new Error(`get_weather failed: Open-Meteo returned ${res.status} ${res.statusText}`);
			}
			const data = (await res.json()) as ForecastResponse;

			return {
				location: resolvedName,
				timezone: data.timezone,
				current: {
					temperature: data.current.temperature_2m,
					apparent_temperature: data.current.apparent_temperature,
					humidity: data.current.relative_humidity_2m,
					wind_speed: data.current.wind_speed_10m,
					precipitation: data.current.precipitation,
					weather_code: data.current.weather_code,
					condition: describe(data.current.weather_code),
				},
				daily: data.daily.time.map((date, i) => ({
					date,
					weather_code: data.daily.weather_code[i],
					condition: describe(data.daily.weather_code[i]),
					temperature_max: data.daily.temperature_2m_max[i],
					temperature_min: data.daily.temperature_2m_min[i],
					precipitation_probability_max: data.daily.precipitation_probability_max[i],
				})),
			};
		},
	});
}

/** Resolve a place name to its top geocoding match, or `null` when none exists. */
async function geocode(fetchImpl: typeof fetch, name: string): Promise<GeoMatch | null> {
	const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
	url.searchParams.set('name', name);
	url.searchParams.set('count', '1');
	url.searchParams.set('language', 'en');
	url.searchParams.set('format', 'json');

	const res = await fetchImpl(url.toString());
	if (!res.ok) {
		throw new Error(`get_weather failed: geocoding returned ${res.status} ${res.statusText}`);
	}
	const body = (await res.json()) as { results?: GeoMatch[] };
	return body.results?.[0] ?? null;
}

interface ForecastResponse {
	timezone: string;
	current: {
		temperature_2m: number;
		relative_humidity_2m: number;
		apparent_temperature: number;
		weather_code: number;
		wind_speed_10m: number;
		precipitation: number;
	};
	daily: {
		time: string[];
		weather_code: number[];
		temperature_2m_max: number[];
		temperature_2m_min: number[];
		precipitation_probability_max: number[];
	};
}
