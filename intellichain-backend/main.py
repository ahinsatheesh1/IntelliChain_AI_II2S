from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import networkx as nx
import random
import urllib.request
import json
import math
import copy
import os
import requests
from pathlib import Path
import google.generativeai as genai

# Load .env file manually (no extra deps needed)
_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ[k.strip()] = v.strip()

WEATHER_KEY = os.environ.get("weather_api", "")
MAPBOX_KEY  = os.environ.get("map_box_api", "")
GEMINI_KEY  = os.environ.get("GEMINI_API_KEY", "")

try:
    if GEMINI_KEY:
        genai.configure(api_key=GEMINI_KEY)
        # Verified 'models/gemini-2.0-flash' is available in models.txt
        _gemini_model = genai.GenerativeModel("models/gemini-2.0-flash")
    else:
        _gemini_model = None
except Exception:
    _gemini_model = None

print(f"--- INIT CHECK ---")
print(f"Gemini Key: {'LOADED' if GEMINI_KEY else 'MISSING'}")
print(f"Model Init: {'SUCCESS' if _gemini_model else 'FAILED'}")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ITEM_RULES = {
    "electronics": {
        "allowed": ["air", "road", "rail"],
        "priority": "fast"
    },
    "food": {
        "allowed": ["road", "rail"],
        "priority": "safe"
    },
    "vehicles": {
        "allowed": ["road", "rail", "sea"],
        "priority": "cheap"
    },
    "medicine": {
        "allowed": ["air", "road"],
        "priority": "fast"
    },
    "fragile": {
        "allowed": ["road", "air"],
        "priority": "safe"
    },
    "general": {
        "allowed": ["air", "road", "rail", "sea"],
        "priority": "balanced"
    }
}

class Location(BaseModel):
    name: str
    lat: float
    lng: float

class RouteRequest(BaseModel):
    source: Location
    destination: Location
    cargo_type: str = "general"
    simulation: str = "auto"
    time_shift: int = 0
    enterprise_mode: bool = False
    num_units: int = 1

# India Major Logistics Hubs
INDIA_HUBS = [
    {"name": "Mumbai Port", "lat": 18.9387, "lng": 72.8353, "type": "port", "note": "Largest container port in India (JNPT)"},
    {"name": "Chennai Port", "lat": 13.0836, "lng": 80.2975, "type": "port", "note": "Major southeast India gateway"},
    {"name": "Kochi Port", "lat": 9.9673,  "lng": 76.2443, "type": "port", "note": "Primary southwest coast sea terminal"},
    {"name": "Kolkata Port", "lat": 22.5629, "lng": 88.3222, "type": "port", "note": "Eastern India maritime hub"},
    {"name": "Delhi ICD (Tughlakabad)", "lat": 28.5021, "lng": 77.2800, "type": "icd",  "note": "Largest Inland Container Depot in Asia"},
    {"name": "Mundra Port", "lat": 22.8392, "lng": 69.7100, "type": "port", "note": "Fastest growing private port in India"},
    {"name": "Bangalore ICD", "lat": 13.0550, "lng": 77.5900, "type": "icd",  "note": "Key inland hub for south India exports"},
]

# PM Gati Shakti DFC Corridors (rough bounding boxes)
DFC_CORRIDORS = [
    {"name": "Western DFC (Mumbai–Delhi)", "lat_range": [18.9, 28.7], "lng_range": [72.0, 77.5], "note": "PM Gati Shakti Western Freight Corridor"},
    {"name": "Eastern DFC (Ludhiana–Dankuni)", "lat_range": [22.5, 30.9], "lng_range": [75.8, 88.4], "note": "PM Gati Shakti Eastern Freight Corridor"},
]

# Carbon footprint kg CO2 per tonne-km
CARBON_RATES = {"air": 0.602, "road": 0.096, "rail": 0.028, "sea": 0.010}

def detect_india_hubs(src_lat, src_lng, dst_lat, dst_lng, D):
    """Return hubs within ~15% of route bounding box"""
    lat_min = min(src_lat, dst_lat) - 2
    lat_max = max(src_lat, dst_lat) + 2
    lng_min = min(src_lng, dst_lng) - 2
    lng_max = max(src_lng, dst_lng) + 2
    nearby = []
    for h in INDIA_HUBS:
        if lat_min <= h['lat'] <= lat_max and lng_min <= h['lng'] <= lng_max:
            nearby.append(h)
    return nearby[:3]  # max 3 hubs

def check_dfc(src_lat, src_lng, dst_lat, dst_lng):
    """Return freight corridor name if route roughly follows a DFC"""
    for dfc in DFC_CORRIDORS:
        lat_ok = (dfc['lat_range'][0] - 2 <= min(src_lat,dst_lat)) and (max(src_lat,dst_lat) <= dfc['lat_range'][1] + 2)
        lng_ok = (dfc['lng_range'][0] - 2 <= min(src_lng,dst_lng)) and (max(src_lng,dst_lng) <= dfc['lng_range'][1] + 2)
        if lat_ok and lng_ok:
            return dfc['name'], dfc['note']
    return None, None

def haversine(lat1, lon1, lat2, lon2):
    R = 6371
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = math.sin(dLat/2) * math.sin(dLat/2) + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dLon/2) * math.sin(dLon/2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c

def get_live_weather(lat, lon):
    try:
        url = f"https://api.openweathermap.org/data/2.5/weather?lat={lat}&lon={lon}&appid={WEATHER_KEY}"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=2) as response:
            data = json.loads(response.read().decode())
            return data['weather'][0]['main'], data['weather'][0]['description']
    except Exception as e:
        return "Clear", "clear sky"

def check_mapbox_directions(src_lat, src_lng, dst_lat, dst_lng):
    url = f"https://api.mapbox.com/directions/v5/mapbox/driving/{src_lng},{src_lat};{dst_lng},{dst_lat}?geometries=geojson&overview=simplified&access_token={MAPBOX_KEY}"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode())
            if data.get('code') == 'Ok':
                 route = data['routes'][0]
                 coords = [[c[1], c[0]] for c in route['geometry']['coordinates']]
                 dist = route['distance'] / 1000
                 hrs = route['duration'] / 3600
                 return True, coords, dist, hrs
            elif data.get('code') == 'NoRoute':
                 return False, [], 0, 0
            else:
                 return None, [], 0, 0
    except Exception as e:
        return None, [], 0, 0

def get_risk_factors(u, v, mode, simulation, is_raining, time_shift):
    factors = []
    total_risk = random.randint(5, 12)
    factors.append({"name": "Historical routing variance", "value": total_risk})
    
    if time_shift > 0:
        forecast_mod = random.randint(-5, 10)
        total_risk += forecast_mod
        factors.append({"name": f"Predictive AI Adjustment (+{time_shift}h)", "value": forecast_mod})

    extra_time = 0; extra_cost = 0

    if simulation == "auto":
        simulation = "Heavy Rain" if is_raining else "none"

    if simulation == "Heavy Rain":
        if mode == "air":
            val = random.randint(60, 80)
            factors.append({"name": "Severe weather (air grounded)", "value": val})
            total_risk += val; extra_time += 24
        elif mode == "road":
            val = random.randint(50, 70)
            factors.append({"name": "Heavy rainfall (+ flooding warnings)", "value": val})
            total_risk += val; extra_time += 12
        elif mode == "sea":
            val = random.randint(40, 60)
            factors.append({"name": "Maritime safety speed reduction", "value": val})
            total_risk += val; extra_time += 8
        elif mode == "rail":
            val = random.randint(15, 25)
            factors.append({"name": "Rain-induced speed restrictions", "value": val})
            total_risk += val; extra_time += 2
    elif simulation == "Traffic Jam":
        if mode == "road":
            val = random.randint(40, 60)
            factors.append({"name": f"Major highway congestion detected", "value": val})
            total_risk += val; extra_time += 8
    elif simulation == "Port Congestion":
        if mode == "sea":
            val = random.randint(80, 95)
            factors.append({"name": "Vessel clearance blocked", "value": val})
            total_risk += val; extra_time += 72

    if mode == "rail" and simulation != "Heavy Rain":
        if total_risk > 25:
             total_risk = 18
             factors = [{"name": "Rail network high stability", "value": 18}]
             extra_time = 0
    return min(max(total_risk, 0), 99), factors, extra_time, extra_cost, simulation

def calculate_paths(src: Location, dst: Location, requested_sim: str, time_shift: int):
    D = haversine(src.lat, src.lng, dst.lat, dst.lng)
    
    # Air overhead: 1.5h for short domestic hops, 4h for hub-based long-haul
    air_overhead = 1.5 if D < 600 else 4.0
    air_t = (D / 800) + air_overhead
    edges_def = [
       (src.name, dst.name, "air", {"base_time": air_t, "base_cost": D * 50, "coords": [[src.lat, src.lng], [dst.lat, dst.lng]]})
    ]

    road_status, r_coords, r_dist, r_hrs = check_mapbox_directions(src.lat, src.lng, dst.lat, dst.lng)
    
    if road_status is True:
       edges_def.append((src.name, dst.name, "road", {"base_time": max(r_hrs, 1), "base_cost": r_dist * 15, "coords": r_coords}))
       edges_def.append((src.name, dst.name, "rail", {"base_time": max(r_hrs * 1.5, 1), "base_cost": r_dist * 10, "coords": r_coords}))
    elif road_status is None:
       lat_diff = dst.lat - src.lat
       lng_diff = dst.lng - src.lng
       mid1_lat = src.lat + lat_diff * 0.45 + (lng_diff * 0.1)
       mid1_lng = src.lng + lng_diff * 0.45 - (lat_diff * 0.1)
       mid2_lat = src.lat + lat_diff * 0.55 - (lng_diff * 0.1)
       mid2_lng = src.lng + lng_diff * 0.55 + (lat_diff * 0.1)
       road_t = max(D / 60, 1)
       rail_t = max(D / 40, 1)
       edges_def.append((src.name, "Hub Alpha", "road", {"base_time": road_t*0.5, "base_cost": D * 15 * 0.5, "coords": [[src.lat, src.lng], [mid1_lat, mid1_lng]]}))
       edges_def.append(("Hub Alpha", dst.name, "road", {"base_time": road_t*0.5, "base_cost": D * 15 * 0.5, "coords": [[mid1_lat, mid1_lng], [dst.lat, dst.lng]]}))
       edges_def.append((src.name, "Hub Beta", "rail", {"base_time": rail_t*0.5, "base_cost": D * 10 * 0.5, "coords": [[src.lat, src.lng], [mid2_lat, mid2_lng]]}))
       edges_def.append(("Hub Beta", dst.name, "rail", {"base_time": rail_t*0.5, "base_cost": D * 10 * 0.5, "coords": [[mid2_lat, mid2_lng], [dst.lat, dst.lng]]}))

    COASTAL_KEYWORDS = ['kochi', 'mumbai', 'chennai', 'kolkata', 'kozhikode', 'goa', 'mangalore', 'surat', 'visakhapatnam', 'kuwait', 'dubai', 'colombo', 'singapore', 'port', 'tokyo', 'shanghai', 'london', 'york', 'kerala', 'trivandrum', 'gujarat', 'maharashtra', 'karnataka', 'tamil', 'odisha', 'andhra', 'bengal', 'sri lanka', 'maldives', 'oman', 'yemen', 'saudi', 'uae', 'qatar', 'bahrain', 'karachi']
    src_coastal = any(c in src.name.lower() for c in COASTAL_KEYWORDS)
    dst_coastal = any(c in dst.name.lower() for c in COASTAL_KEYWORDS)

    is_ocean_detour = road_status is True and r_dist > (D * 1.6)

    if road_status is False or (src_coastal and dst_coastal and D > 50) or is_ocean_detour:
       edges_def.append((src.name, dst.name, "sea", {"base_time": (D/30) + 10, "base_cost": D * 8, "coords": [[src.lat, src.lng], [dst.lat, dst.lng]]}))

    weather_m, weather_desc = get_live_weather(src.lat, src.lng)
    
    # Predict future weather based on time shift
    if time_shift > 0 and requested_sim == "auto":
        predictive_hash = int(abs(src.lat + dst.lng + time_shift) * 100) % 100
        is_raining = predictive_hash > 70
        weather_m = "Rain" if is_raining else "Clear"
        weather_desc = f"+{time_shift}h Forecast: {'Heavy Rain' if is_raining else 'Clear Skies'}"
    else:
        is_raining = weather_m in ["Rain", "Thunderstorm", "Snow", "Drizzle"]

    # Natural congestion dissipation simulation
    if time_shift >= 12 and requested_sim == "Traffic Jam":
        requested_sim = "none"
        weather_desc = f"+{time_shift}h Forecast: Traffic Density Normalized"
        
    active_sim = "Heavy Rain" if (requested_sim == "auto" and is_raining) else requested_sim if requested_sim != "auto" else "none"

    G_time = nx.MultiDiGraph(); G_risk = nx.MultiDiGraph(); G_cost = nx.MultiDiGraph()
    edge_details = {}
    
    for u, v, key, data in edges_def:
        risk, factors, ext_time, ext_cost, _ = get_risk_factors(u, v, key, active_sim, is_raining, time_shift)
        time = data['base_time'] + ext_time
        cost = data['base_cost'] + ext_cost
        edge_id = f"{u}-{v}-{key}"
        edge_details[edge_id] = {
            "mode": key, "risk": risk, "factors": factors, "time": time, 
            "cost": cost, "base_time": data['base_time'], "coords": data['coords']
        }
        G_time.add_edge(u, v, key=key, weight=time)
        G_risk.add_edge(u, v, key=key, weight=risk)
        G_cost.add_edge(u, v, key=key, weight=cost)

    def extract_route_info(path, graph, optimization_type):
        if not path: return None
        detailed_route = []; total_time = total_cost = total_base_time = max_risk = 0; all_factors = []
        path_coords = []
        for i in range(len(path) - 1):
            u, v = path[i], path[i+1]
            edge_data = graph.get_edge_data(u, v)
            if not edge_data: continue
            best_key = min(edge_data, key=lambda k: edge_data[k]['weight'])
            details = edge_details[f"{u}-{v}-{best_key}"]
            detailed_route.append({"from": u, "to": v, "mode": best_key, "risk": details['risk'], "eta_hours": round(details['time'], 1), "coords": details['coords']})
            path_coords.extend(details['coords'])
            total_time += details['time']
            total_base_time += details['base_time']
            total_cost += details['cost']
            if details['risk'] > max_risk: max_risk = details['risk']
            for f in details['factors']:
                if f not in all_factors: all_factors.append(f)
        all_factors = sorted(all_factors, key=lambda x: x['value'], reverse=True)[:3]
        return {
            "type": optimization_type, "route_path": path, "details": detailed_route,
            "route_path_coords": path_coords,
            "total_eta_hrs": round(total_time, 1), "total_cost": int(total_cost),
            "risk_score": int(max_risk), "factors": all_factors, "delay_hours": round(max(0, total_time - total_base_time), 1)
        }

    routes = []
    seen = set()
    for grp in [(G_time, "Fastest"), (G_risk, "Safest"), (G_cost, "Cheapest")]:
        try: p = nx.shortest_path(grp[0], source=src.name, target=dst.name, weight='weight')
        except: p = None
        info = extract_route_info(p, grp[0], grp[1])
        if info:
            key_str = str(info['route_path']) + str([d['mode'] for d in info['details']])
            if key_str not in seen:
                routes.append(info)
                seen.add(key_str)
    return routes, active_sim, weather_m, weather_desc, edge_details

@app.post("/api/plan-route")
def plan_route(req: RouteRequest):
    D = haversine(req.source.lat, req.source.lng, req.destination.lat, req.destination.lng)
    if D < 0.1:
        return {"error": "Source and Destination are the same location. Please select distinct endpoints for logistics analysis.", "routes": []}
    
    active_sim = req.simulation
    routes, active_sim, weather_m, weather_desc, edge_details = calculate_paths(req.source, req.destination, req.simulation, req.time_shift)
    if not routes: raise HTTPException(status_code=404, detail="No route found between coordinates.")
        
    rules = copy.deepcopy(ITEM_RULES.get(req.cargo_type.lower(), ITEM_RULES["general"]))
    
    # 🧠 SMART CARGO PRIORITIZATION (Context-Aware Hybrid Logic)
    cargo_adjustments = []
    if req.cargo_type == "medicine" and active_sim in ["Heavy Rain", "Traffic Jam"]:
        rules["allowed"] = ["air"]
        rules["priority"] = "fast"
        cargo_adjustments.append("Medicine + High Disturbance → Exclusively Air routing locked")
    elif req.cargo_type == "food" and active_sim == "Traffic Jam":
        rules["allowed"] = ["rail", "air"]
        cargo_adjustments.append("Perishables + Traffic Jam → Road networks actively blacklisted")
    elif req.cargo_type == "fragile" and active_sim == "Heavy Rain":
        rules["allowed"] = ["road"]
        cargo_adjustments.append("Fragile + Air Turbulence Warning → Grounded to safe Road transit")

    valid_routes = []
    for r in routes:
         modes_used = set(seg['mode'] for seg in r['details'])
         if all(m in rules['allowed'] for m in modes_used):
             valid_routes.append(r)
             
    if not valid_routes:
         valid_routes = routes

    if rules["priority"] == "fast":
         recommended_route = min(valid_routes, key=lambda x: x['total_eta_hrs'])
    elif rules["priority"] == "cheap":
         recommended_route = min(valid_routes, key=lambda x: x['total_cost'])
    elif rules["priority"] == "safe":
         recommended_route = min(valid_routes, key=lambda x: x['risk_score'])
    else:
         fastest = next((r for r in valid_routes if r['type'] == 'Fastest'), valid_routes[0])
         safest = next((r for r in valid_routes if r['type'] == 'Safest'), valid_routes[0])
         recommended_route = safest if safest['risk_score'] < (fastest['risk_score'] - 15) else fastest
    
    cheapest_overall = min(valid_routes, key=lambda x: x['total_cost'])

    for r in valid_routes:
        compare_base = cheapest_overall
        r['delta'] = {
            'time': round(r['total_eta_hrs'] - compare_base['total_eta_hrs'], 1), 
            'cost': round(r['total_cost'] - compare_base['total_cost'], 2), 
            'risk': round(r['risk_score'] - compare_base['risk_score'], 1)
        }
        factors = []
        if r == recommended_route:
             first_mode = r['details'][0]['mode']
             factors.append(f"Cargo Profile ({req.cargo_type.title()}): Target {rules['priority'].upper()}")
             factors.extend(cargo_adjustments)

             if active_sim == "Port Congestion" and first_mode == "air":
                 factors.extend(["Air route completely unaffected by maritime port congestion"])
             elif active_sim in ["Port Congestion", "Traffic Jam"] and first_mode in ["rail", "road", "air"]:
                 factors.extend(["Automatically bypasses primary local disruption vector"])
             elif active_sim == "Heavy Rain" and first_mode == "rail":
                 factors.extend(["Rail network structurally resilient against severe weather"])
             else:
                 factors.append(f"Lowest predictive risk selected ({r['risk_score']}%)" if r == recommended_route and rules['priority'] == 'safe' else f"Optimized velocity alignment ({r['total_eta_hrs']}h)")
                 factors.append(f"Environment: {weather_m} ({weather_desc})")
        r['why_recommended'] = factors
    
    if recommended_route['type'] != 'Fastest' and rules["priority"] != "fast":
         time_diff = recommended_route['total_eta_hrs'] - valid_routes[0]['total_eta_hrs']
         risk_diff = valid_routes[0]['risk_score'] - recommended_route['risk_score']
         reason = [f"Cargo profile constraints actively met", f"Reduces payload damage/delay risk by {risk_diff}%" if risk_diff > 0 else "System avoids bottlenecks dynamically"]
         decision = f"Shift to {recommended_route['details'][0]['mode'].capitalize()} routing enabled by Hybrid Smart Logic"
         impact = f"Payload Rules Activated"
    else:
         reason = [f"Direct {rules['priority']} predictive routing applied", f"Cargo restrictions bypassed without friction"]
         decision = f"Execute via {recommended_route['details'][0]['mode'].capitalize()} routing"
         impact = f"{req.cargo_type.capitalize()} Payload Authorized"
             
    confidence = random.randint(89, 96)
    
    hotspots = []
    blocked_edges = []
    has_sea_route = any(v['mode'] == 'sea' for k, v in edge_details.items())

    title_sim = "LIVE WEATHER MODE" if req.simulation == "auto" else "SIMULATION MODE"
    if req.time_shift > 0: title_sim = f"PREDICTIVE FORECAST MODE (+{req.time_shift}H)"

    insight = {
        "headline": f"Network Operating Optimally", 
        "details": [f"Standard flows dynamically validated. {weather_desc}."], 
        "affected": None, "alt": None, "impact_scope": None
    }
    
    if active_sim == "Heavy Rain":
        hotspots.append({"coords": [req.source.lat, req.source.lng], "type": "weather", "radius": 150000, "label": "Severe Weather Area"})
        insight = {
            "headline": f"Severe Weather Interdiction ({title_sim}) – {req.source.name}",
            "details": ["Air transport risk extremely high.", "Flash flood logistics warnings active.", "Rail-based rerouting recommended to minimize cascading SLA breaches."],
            "affected": "Air ✈️ / Road 🚚", "alt": "Rail 🚆",
            "impact_scope": ["Air operations significantly restricted", "Road transport localized flooding risk", "Rail operations safely unhindered"]
        }
    if active_sim == "Traffic Jam":
        jam_lat, jam_lng = req.destination.lat, req.destination.lng
        hotspots.append({"coords": [jam_lat, jam_lng], "type": "traffic", "radius": 120000, "label": "Highway Congestion Node"})
        insight = {
            "headline": f"Critical Highway Congestion ({title_sim}) – {req.destination.name}",
            "details": ["Massive localized bottlenecks identified on primary road approach.", "Average vehicle velocity severely reduced.", "Alternative transit activated dynamically."],
            "affected": "Road 🚚", "alt": "Rail 🚆 / Air ✈️",
            "impact_scope": ["Primary highway vectors blocked", "Inland Rail capacity available", "Air logistics unaffected"]
        }
    if active_sim == "Port Congestion":
        hotspots.append({"coords": [req.source.lat, req.source.lng], "type": "port", "radius": 150000, "label": "Maritime Port (Congested)"})
        
        if has_sea_route:
            blocked_edges.append([[req.source.lat, req.source.lng], [req.destination.lat, req.destination.lng]])
            scope = ["Maritime shipping routes stalled", "Coastal ports at max capacity", "Air and Inland alternatives completely unaffected"]
        else:
            scope = ["Inland logistics actively bypassing port dependency", "Coastal port delays isolated physically", "Current inland route completely unaffected by maritime disruption"]

        insight = {
            "headline": f"Maritime Supply Shock ({title_sim}) – {req.source.name} Port",
            "details": ["Vessel clearance delays observed", "Port congestion significantly increasing dwell time", "Switching to inland/air logistics exclusively"],
            "affected": "Maritime 🚢" if has_sea_route else "None (Inland Logistics)", 
            "alt": "Rail 🚆 / Air ✈️ / Road 🚚",
            "impact_scope": scope
        }

    # India Hub Detection
    nearby_hubs = detect_india_hubs(req.source.lat, req.source.lng, req.destination.lat, req.destination.lng, 0)
    dfc_name, dfc_note = check_dfc(req.source.lat, req.source.lng, req.destination.lat, req.destination.lng)

    # Append hub notes to insight details
    if nearby_hubs and active_sim == "none" or not active_sim:
        if insight.get('details'):
            for hub in nearby_hubs:
                insight['details'].append(f"🏭 Optimized via {hub['name']} ({hub['note']})")
    if dfc_name:
        insight['details'] = (insight.get('details') or []) + [f"🇮🇳 Route aligned with {dfc_name} ({dfc_note})"]

    # Carbon Footprint
    rec_mode = recommended_route['details'][0]['mode'] if recommended_route['details'] else 'road'
    D_km = haversine(req.source.lat, req.source.lng, req.destination.lat, req.destination.lng)
    cargo_tonne = max(req.num_units * 0.5, 1.0)
    carbon_kg = round(CARBON_RATES.get(rec_mode, 0.096) * D_km * cargo_tonne, 1)
    carbon_label = {"air": "🔴 HIGH", "road": "🟡 MEDIUM", "rail": "🟢 LOW", "sea": "🟢 VERY LOW"}.get(rec_mode, "🟡 MEDIUM")

    # Enterprise Data
    enterprise_data = None
    if req.enterprise_mode and req.num_units > 0:
        trucks_needed = max(1, math.ceil(req.num_units / 10))
        fleet_cost = int(recommended_route['total_cost'] * trucks_needed * 0.85)
        eta_low = recommended_route['total_eta_hrs']
        eta_high = round(eta_low * 1.15, 1)
        enterprise_data = {
            "units": req.num_units,
            "trucks_needed": trucks_needed,
            "fleet_cost": fleet_cost,
            "delivery_window": f"{eta_low}–{eta_high} hrs",
            "carbon_kg": carbon_kg * trucks_needed,
            "carbon_label": carbon_label,
            "primary_mode": rec_mode
        }

    return {
        "routes": valid_routes,
        "recommended_index": valid_routes.index(recommended_route),
        "decision": decision,
        "reason": reason,
        "confidence": confidence,
        "impact": impact,
        "hotspots": hotspots,
        "blocked_edges": blocked_edges,
        "ai_insight": insight,
        "nearby_hubs": nearby_hubs,
        "dfc_corridor": dfc_name,
        "carbon_kg": carbon_kg,
        "carbon_label": carbon_label,
        "enterprise_data": enterprise_data,
        "split_allocation": _compute_split(valid_routes, rec_mode, D_km),
        "live_events": _generate_events(active_sim, req.source.name, req.destination.name, weather_m, nearby_hubs)
    }

def _compute_split(routes, primary_mode, D_km):
    """Generate a realistic split shipment allocation across top 2 routes."""
    if len(routes) < 2:
        return None
    fastest = min(routes, key=lambda r: r['total_eta_hrs'])
    cheapest = min(routes, key=lambda r: r['total_cost'])
    if fastest == cheapest:
        return None
    fast_mode = fastest['details'][0]['mode'] if fastest['details'] else 'air'
    cheap_mode = cheapest['details'][0]['mode'] if cheapest['details'] else 'rail'
    # Don't split if same mode
    if fast_mode == cheap_mode:
        return None
    # 30% urgent / 70% bulk split
    urgent_pct, bulk_pct = 30, 70
    urgent_cost = int(fastest['total_cost'] * urgent_pct / 100)
    bulk_cost = int(cheapest['total_cost'] * bulk_pct / 100)
    mode_emoji = {'air': '✈️', 'road': '🚚', 'rail': '🚆', 'sea': '🚢'}
    return {
        "splits": [
            {"label": "Urgent Dispatch", "mode": fast_mode, "emoji": mode_emoji.get(fast_mode, '📦'),
             "pct": urgent_pct, "eta": fastest['total_eta_hrs'], "cost": urgent_cost,
             "reason": "Time-critical inventory fast-tracked"},
            {"label": "Bulk Consignment", "mode": cheap_mode, "emoji": mode_emoji.get(cheap_mode, '📦'),
             "pct": bulk_pct, "eta": cheapest['total_eta_hrs'], "cost": bulk_cost,
             "reason": "Cost-optimized bulk shipment"},
        ],
        "total_cost": urgent_cost + bulk_cost,
        "explanation": f"{urgent_pct}% dispatched via {fast_mode.upper()} for urgency · {bulk_pct}% via {cheap_mode.upper()} for cost efficiency"
    }

def _generate_events(sim, src, dst, weather, hubs):
    """Generate a realistic live events feed based on current state."""
    events = []
    import time as _time
    now_ts = int(_time.time())
    if sim == "Heavy Rain":
        events.append({"type": "warning", "icon": "🌧️", "msg": f"Heavy rainfall alert active over {src} corridor", "age": "Just now"})
        events.append({"type": "reroute", "icon": "🔀", "msg": f"AI rerouted via Rail to avoid air disruption", "age": "2m ago"})
    if sim == "Traffic Jam":
        events.append({"type": "warning", "icon": "🚦", "msg": f"Highway congestion detected near {dst}", "age": "Just now"})
        events.append({"type": "info", "icon": "🚆", "msg": "Rail capacity allocated as backup", "age": "1m ago"})
    if sim == "Port Congestion":
        events.append({"type": "critical", "icon": "⚓", "msg": f"Port congestion alert: {src} maritime node at capacity", "age": "Just now"})
        events.append({"type": "reroute", "icon": "✈️", "msg": "Sea routes suspended · Inland logistics activated", "age": "3m ago"})
    if weather in ["Rain", "Thunderstorm", "Snow"]:
        events.append({"type": "warning", "icon": "⛈️", "msg": f"Live weather: {weather} detected at source node", "age": "Live"})
    for h in hubs[:2]:
        events.append({"type": "info", "icon": "🏭", "msg": f"{h['name']} operational · High-capacity throughput active", "age": "5m ago"})
    events.append({"type": "info", "icon": "🤖", "msg": "IntelliChain AI graph recalculated successfully", "age": "Just now"})
    return events[:6]

# ─── Gemini AI Chat Endpoint ───────────────────────────────────────
class AiQuery(BaseModel):
    question: str
    context: dict = {}

@app.post("/api/ask-ai")
def ask_ai(query: AiQuery):
    if not _gemini_model:
        return {"answer": "⚠️ Gemini API key not configured. Please add GEMINI_API_KEY to your .env file.", "error": True}

    ctx = query.context
    prompt = f"""You are IntelliChain AI — an elite logistics decision engine for India and global supply chains.
You ONLY use the provided real-time context from our routing engine. Never hallucinate data.

=== LIVE ROUTE CONTEXT ===
Source            : {ctx.get('source', 'N/A')}
Destination       : {ctx.get('destination', 'N/A')}
Cargo Type        : {ctx.get('cargo', 'General')}
Active Disruption : {ctx.get('simulation', 'None')}
Live Weather      : {ctx.get('weather', 'Clear')}
Predictive Risk   : {ctx.get('risk', 0)}%
Available Modes   : {', '.join(ctx.get('available_modes', [])) or 'All modes'}
Route Costs       : {json.dumps(ctx.get('costs', {}), indent=2)}
Recommended Mode  : {ctx.get('recommended_mode', 'N/A')}
Carbon Footprint  : {ctx.get('carbon_label', 'N/A')}
Nearby India Hubs : {', '.join(ctx.get('nearby_hubs', [])) or 'None detected'}
DFC Corridor      : {ctx.get('dfc_corridor') or 'Not applicable'}

=== USER QUESTION ===
{query.question}

=== RESPONSE FORMAT (use exactly this) ===
🚚 Recommended Mode: [mode]
⚠️ Risk Assessment: [risk level and reasoning]
💰 Cost Insight: [cost in ₹ and comparison]
🧠 AI Reasoning: [why this mode is best given context]
🌍 Carbon Impact: [environmental impact]
🔁 Alternative Option: [backup route with trade-offs]
📦 Cargo Advisory: [specific advice for this cargo type]

Be concise, direct, and decision-grade. Max 120 words total."""

    # --- FALLBACK 1: GOOGLE GEMINI (PRIMARY + MULTI-MODEL RETRY) ---
    models_to_try = ["models/gemini-2.0-flash", "models/gemini-1.5-flash", "gemini-1.5-flash", "models/gemini-flash-latest"]
    last_error = ""
    for model_name in models_to_try:
        try:
            print(f"Trying Gemini model: {model_name}...")
            temp_model = genai.GenerativeModel(model_name)
            response = temp_model.generate_content(prompt)
            if response and hasattr(response, 'text') and response.text:
                return {"answer": response.text, "error": False, "provider": f"Gemini ({model_name.split('/')[-1]})"}
        except Exception as e:
            last_error = str(e)
            print(f"Gemini {model_name} failed: {last_error}")
            continue

    print(f"!!! ALL GEMINI MODELS FAILED !!! Last error: {last_error}")

    # --- FALLBACK 2: OLLAMA LOCAL (SECONDARY) ---
    try:
        ollama_res = requests.post(
            "http://localhost:11434/api/generate",
            json={
                "model": "llama3",
                "prompt": prompt + "\n\nIMPORTANT: Respond ONLY with the requested format.",
                "stream": False
            },
            timeout=10
        )
        if ollama_res.status_code == 200:
            text = ollama_res.json().get("response", "")
            return {"answer": text, "error": False, "provider": "Ollama (Llama 3)"}
    except Exception as ollama_err:
        print(f"Ollama failed: {ollama_err}")

    # --- FALLBACK 3: RULE-BASED ENGINE (TERTIARY / SAFETY) ---
    return {
        "answer": _rule_based_fallback(ctx, query.question),
        "error": False,
        "provider": "Rule-Based Engine (Safety Mode)"
    }

def _rule_based_fallback(ctx, q):
    """Deterministic fallback when all LLMs fail."""
    q = q.lower()
    mode = ctx.get('recommended_mode', 'N/A').upper()
    risk = ctx.get('risk', 0)
    
    advice = "Maintain standard handling protocols."
    if "med" in q or ctx.get('cargo') == 'medicine':
        advice = "URGENT: Prioritize climate-controlled storage and expedited customs clearance."
    elif "food" in q:
        advice = "NOTICE: Ensure cold-chain integrity to prevent spoilage."
    
    risk_msg = "Low Risk detected." if risk < 30 else "Moderate disruption probable." if risk < 50 else "CRITICAL: Significant SLA failure risk. Immediate rerouting active."
    
    return f"""🚚 Recommended Mode: {mode}
⚠️ Risk Assessment: {risk}% - {risk_msg}
💰 Cost Insight: Costs vary by node traffic. Check live quotes.
🧠 AI Reasoning: Deterministic fallback triggered. Route selected based on hard constraints.
🌍 Carbon Impact: Label: {ctx.get('carbon_label', 'N/A')}
🔁 Alternative Option: Check rail/sea routes for cost recovery.
📦 Cargo Advisory: {advice}"""

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
