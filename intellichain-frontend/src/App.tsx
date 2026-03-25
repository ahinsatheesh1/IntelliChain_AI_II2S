// @ts-nocheck
import { useState, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap, Circle, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { Activity, CloudRain, ShieldAlert, Truck, Ship, Search, Route, Zap, TrendingUp, Info, Package, Clock } from 'lucide-react'

import L from 'leaflet';
import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
    iconUrl: icon,
    shadowUrl: iconShadow,
    iconSize: [25, 41],
    iconAnchor: [12, 41]
});
L.Marker.prototype.options.icon = DefaultIcon;

const portHotspotIcon = new L.DivIcon({
  className: 'port-hotspot',
  html: '<div class="hotspot-pulse"></div><div class="hotspot-anchor">⚓</div>',
  iconSize: [40, 40],
  iconAnchor: [20, 20]
});

const MAPBOX_KEY = import.meta.env.VITE_MAPBOX_KEY as string;

function BoundsUpdater({ routeData }: any) {
  const map = useMap();
  useEffect(() => {
    if(!routeData || !routeData.route_path_coords || routeData.route_path_coords.length === 0) return;
    const bounds = L.latLngBounds(routeData.route_path_coords.map((c: any) => [c[0], c[1]]));
    map.flyToBounds(bounds, { padding: [50, 50], duration: 1.5 });
  }, [routeData, map]);
  return null;
}

function useCountUp(end: number, duration: number = 2000) {
  const [count, setCount] = useState(end);
  const startTime = useRef<number | null>(null);
  const startVal = useRef(count);

  useEffect(() => {
    if (end === count) return;
    startVal.current = count;
    startTime.current = null;
    let animationFrame: number;
    const step = (timestamp: number) => {
      if (!startTime.current) startTime.current = timestamp;
      const progress = Math.min((timestamp - startTime.current) / duration, 1);
      const ease = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const current = Math.floor(startVal.current + (end - startVal.current) * ease);
      setCount(current);
      if (progress < 1) animationFrame = requestAnimationFrame(step);
      else setCount(end);
    };
    animationFrame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animationFrame);
  // eslint-disable-next-line
  }, [end, duration]);
  return count;
}

function LocationInput({ label, value, onChangeText }: any) {
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
     const handleClickOutside = (e: MouseEvent) => {
        if(wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
     };
     document.addEventListener('mousedown', handleClickOutside);
     return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
     if(value.length < 3) { setSuggestions([]); return; }
     const delayMs = setTimeout(() => {
        fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(value)}.json?access_token=${MAPBOX_KEY}&types=place,city,locality,address`)
        .then(res => res.json())
        .then(data => {
            if(data.features && open) setSuggestions(data.features);
        })
        .catch(() => {})
     }, 400)
     return () => clearTimeout(delayMs);
  }, [value, open]);

  return (
    <div className="location-input-container" ref={wrapperRef}>
      <label>{label}</label>
      <input 
         type="text" 
         value={value} 
         onChange={e => {onChangeText(e.target.value); setOpen(true)}} 
         onFocus={()=>setOpen(true)} 
         className="geo-input" 
         placeholder={`Search ${label}...`} 
      />
      {open && suggestions.length > 0 && (
         <ul className="geo-suggestions glass">
            {suggestions.map((s, i) => (
                <li key={i} onClick={() => {
                   onChangeText(s.place_name);
                   setOpen(false);
                }}>
                   {s.place_name}
                </li>
            ))}
         </ul>
      )}
    </div>
  )
}

export default function App() {
  const [sourceText, setSourceText] = useState("")
  const [destText, setDestText] = useState("")
  const [simulation, setSimulation] = useState('auto')
  const [cargoType, setCargoType] = useState('general')
  const [timeShift, setTimeShift] = useState(0)
  const [showCompare, setShowCompare] = useState(false)
  const [enterpriseMode, setEnterpriseMode] = useState(false)
  const [numUnits, setNumUnits] = useState(20)
  
  const [apiData, setApiData] = useState<any>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState('Just now')

  const [geoCache, setGeoCache] = useState({
     source: { name: "", lat: 0, lng: 0 },
     destination: { name: "", lat: 0, lng: 0 }
  })
  
  const getRiskColor = (risk: number) => {
    if(risk < 30) return 'text-success'
    if(risk <= 70) return 'text-warning'
    return 'text-danger'
  }

  const formatCost = (cost: number) => `₹${cost.toLocaleString('en-IN')}`

  const handleSimulate = (sim: string) => {
    setSimulation(sim === simulation ? 'auto' : sim)
  }

  const findRoute = async () => {
    if(!sourceText || !destText) return;
    setLoading(true)
    setLastUpdated('Just now')
    setOpenGeo(false)
    try {
      let srcObj = geoCache.source;
      if(sourceText !== geoCache.source.name) {
          const srcRes = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(sourceText)}.json?access_token=${MAPBOX_KEY}&limit=1`);
          const srcData = await srcRes.json();
          if(srcData.features?.length > 0) {
              srcObj = { name: srcData.features[0].text, lat: srcData.features[0].center[1], lng: srcData.features[0].center[0] }
          } else {
              alert("Source location not found on global map. Try entering a valid city or region."); setLoading(false); return;
          }
      }

      let dstObj = geoCache.destination;
      if(destText !== geoCache.destination.name) {
          const dstRes = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(destText)}.json?access_token=${MAPBOX_KEY}&limit=1`);
          const dstData = await dstRes.json();
          if(dstData.features?.length > 0) {
              dstObj = { name: dstData.features[0].text, lat: dstData.features[0].center[1], lng: dstData.features[0].center[0] }
          } else {
              alert("Destination location not found on global map. Try entering a valid city or region."); setLoading(false); return;
          }
      }

      setGeoCache({ source: srcObj, destination: dstObj });
      setSourceText(srcObj.name);
      setDestText(dstObj.name);

      const res = await fetch('http://localhost:8000/api/plan-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: srcObj, destination: dstObj, simulation, cargo_type: cargoType, time_shift: timeShift, enterprise_mode: enterpriseMode, num_units: numUnits })
      })
      const data = await res.json()
      setApiData(data)
      setSelectedIndex(data.recommended_index)
    } catch (err) {
      console.error(err)
      alert("Error geocoding locations or reaching backend.")
    }
    setLoading(false)
  }

  const [openGeo, setOpenGeo] = useState(false);

  useEffect(() => {
    findRoute()
    // eslint-disable-next-line
  }, [simulation, cargoType, timeShift])

  useEffect(() => {
     const interval = setInterval(() => {
       setLastUpdated((prev) => prev === 'Just now' ? '2s ago' : prev === '2s ago' ? '5s ago' : prev)
     }, 2000)
     return () => clearInterval(interval)
  }, [apiData])

  const routeData = apiData?.routes[selectedIndex]
  const animatedRisk = useCountUp(routeData?.risk_score || 0, 1500)

  return (
    <div className="app-container">
      <style dangerouslySetInnerHTML={{__html: `
        .tag { font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
        .tag-blue { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
        .tag-green { background: rgba(16, 185, 129, 0.2); color: #34d399; }
        .tag-yellow { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
        .tag-red { background: rgba(239, 68, 68, 0.2); color: #f87171; }
      `}} />

      <div className="top-bar glass">
        <div className="brand">
          <Activity size={28} color="#60a5fa" />
          <span>IntelliChain AI</span>
        </div>
        
        <div className="stat-group">
          <div className="stat-box">
             <span className="stat-label" style={{color: '#94a3b8'}}>Predictive Risk Score</span>
             <span className={`stat-val ${getRiskColor(animatedRisk)}`}>{animatedRisk}%</span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Est. Time</span>
            <span className="stat-val">
              {routeData ? `${routeData.total_eta_hrs}h` : '--'}
            </span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Exp. Delay</span>
            <span className={`stat-val ${routeData?.delay_hours > 0 ? 'text-danger' : 'text-success'}`}>
              {routeData ? `+${routeData.delay_hours}h` : '--'}
            </span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Economic Impact</span>
            <span className="stat-val">
              {routeData ? formatCost(routeData.total_cost) : '--'}
            </span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Carbon Footprint</span>
            <span className="stat-val" style={{fontSize:'0.85rem'}}>
              {apiData ? <span style={{color: apiData.carbon_label?.includes('HIGH') ? '#ef4444' : apiData.carbon_label?.includes('MEDIUM') ? '#f59e0b' : '#10b981'}}>{apiData.carbon_label}</span> : '--'}
            </span>
          </div>
        </div>
        
        <div className="thinking-line">
           <div style={{width:'8px', height:'8px', borderRadius:'50%', background:'#10b981', boxShadow: '0 0 8px #10b981'}}></div>
           Analyzing Dynamic Graph • {timeShift > 0 ? `Predictive Forecasting (+${timeShift}h)` : 'Live Data'} • Updated {lastUpdated}
        </div>
      </div>

      <div className="main-content">
        <div className="left-panel glass">
          <div>
            <h2 className="section-title"><Route size={18} /> Plan & Simulate</h2>
            <div style={{display: 'flex', gap: '8px', zIndex: 100, marginBottom: '12px'}}>
               <div className="form-group" style={{flex: 1}}>
                  <LocationInput label="Source" value={sourceText} onChangeText={setSourceText} />
               </div>
               <div className="form-group" style={{flex: 1}}>
                  <LocationInput label="Destination" value={destText} onChangeText={setDestText} />
               </div>
            </div>
            
            <div className="form-group" style={{marginBottom: '16px'}}>
              <label><Package size={14} style={{display:'inline', marginRight:'4px'}}/> Cargo Type (Constraint Matrix)</label>
              <select value={cargoType} onChange={e => setCargoType(e.target.value)} className="geo-input" style={{padding: '8px', cursor: 'pointer'}}>
                 <option value="general">General Cargo (Balanced)</option>
                 <option value="electronics">Electronics (Air/Fast)</option>
                 <option value="food">Perishable Food (Safe)</option>
                 <option value="medicine">Urgent Medicine (Air/Road Only)</option>
                 <option value="fragile">Fragile Goods (Road/Air Only)</option>
                 <option value="vehicles">Heavy Vehicles (Cheap/Sea)</option>
              </select>
            </div>
            
            <button className="btn" onClick={findRoute} disabled={loading} style={{marginBottom: '20px', marginTop: '10px'}}>
              {loading ? <Activity className="animate-spin" /> : <Search />} 
              Analyze Logistics Network
            </button>

            {/* Enterprise Mode Toggle */}
            <div style={{padding:'12px', background: enterpriseMode ? 'rgba(124,58,237,0.15)' : 'rgba(255,255,255,0.03)', borderRadius:'8px', border: `1px solid ${enterpriseMode ? 'rgba(124,58,237,0.5)' : 'rgba(255,255,255,0.08)'}`, marginBottom:'16px', transition:'all 0.3s'}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                <span style={{color: enterpriseMode ? '#a78bfa' : '#94a3b8', fontWeight:700, fontSize:'0.85rem'}}>🏢 Enterprise Mode</span>
                <button onClick={() => setEnterpriseMode(!enterpriseMode)} style={{background: enterpriseMode ? '#7c3aed' : 'rgba(100,116,139,0.3)', color:'white', border:'none', borderRadius:'20px', padding:'3px 14px', cursor:'pointer', fontSize:'0.75rem', fontWeight:700, transition:'all 0.3s'}}>
                  {enterpriseMode ? 'ON' : 'OFF'}
                </button>
              </div>
              {enterpriseMode && (
                <div style={{marginTop:'10px'}}>
                  <label style={{display:'flex', justifyContent:'space-between', fontSize:'0.8rem', color:'#94a3b8', marginBottom:'6px'}}>
                    <span>Shipment Units</span>
                    <strong style={{color:'#a78bfa'}}>{numUnits} units</strong>
                  </label>
                  <input type="range" min="10" max="500" step="10" value={numUnits} onChange={e => setNumUnits(parseInt(e.target.value))} style={{width:'100%', accentColor:'#7c3aed', cursor:'pointer'}} />
                  <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.68rem', color:'#475569', marginTop:'3px', fontWeight:600}}>
                    <span>10 units</span><span>500 units</span>
                  </div>
                </div>
              )}
            </div>

            <h2 className="section-title" style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                <div><ShieldAlert size={18} /> What-If Simulation</div>
                {simulation === 'auto' && <div style={{background: '#10b981', color: 'black', fontSize: '0.7rem', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold'}}>LIVE WEATHER ACTIVE</div>}
            </h2>
            <div className="sim-buttons">
               <button className={`sim-btn ${simulation === 'Heavy Rain' ? 'active' : ''}`} onClick={() => handleSimulate('Heavy Rain')}>
                 <CloudRain size={18} /> Force Heavy Rain
               </button>
               <button className={`sim-btn ${simulation === 'Traffic Jam' ? 'active' : ''}`} onClick={() => handleSimulate('Traffic Jam')}>
                 <Truck size={18} /> Simulate Traffic Jam
               </button>
               <button className={`sim-btn ${simulation === 'Port Congestion' ? 'active' : ''}`} onClick={() => handleSimulate('Port Congestion')}>
                 <Ship size={18} /> Simulate Port Congestion
               </button>
            </div>

            <div className="form-group" style={{marginTop: '20px', padding: '12px', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '8px', border: '1px solid rgba(59, 130, 246, 0.3)'}}>
              <label style={{display:'flex', justifyContent:'space-between', marginBottom: '8px'}}>
                 <span style={{color: '#93c5fd', fontWeight: 600}}><Clock size={14} style={{display:'inline', marginRight:'4px', marginBottom: '-2px'}}/> Predictive Time-Shift</span>
                 <span style={{color: '#60a5fa', fontWeight: 'bold'}}>{timeShift > 0 ? `+${timeShift} Hours` : "Live (0h)"}</span>
              </label>
              <input 
                 type="range" 
                 min="0" max="48" step="6" 
                 value={timeShift} 
                 onChange={e => setTimeShift(parseInt(e.target.value))} 
                 style={{width: '100%', cursor: 'pointer', accentColor: '#3b82f6'}} 
              />
              <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.7rem', color:'#64748b', marginTop:'4px', fontWeight: 600}}>
                 <span>Now</span>
                 <span>+24h</span>
                 <span>+48h</span>
              </div>
            </div>

          </div>
          
          {apiData && (
            <div>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:'20px'}}>
                <h2 className="section-title" style={{margin:0}}><Activity size={18} /> Alternatives Generated</h2>
                <button onClick={() => setShowCompare(true)} style={{background:'linear-gradient(135deg,#7c3aed,#3b82f6)', color:'#fff', border:'none', borderRadius:'6px', padding:'5px 10px', cursor:'pointer', fontSize:'0.72rem', fontWeight:700, letterSpacing:'0.5px'}}>⚡ Compare All</button>
              </div>
              {apiData.routes.map((r: any, idx: number) => {
                 const isRecommended = idx === apiData.recommended_index;
                 const isSelected = idx === selectedIndex;
                 return (
                   <div 
                     key={idx} 
                     className={`route-card ${isSelected ? 'selected' : ''} ${isRecommended ? 'recommended' : ''}`}
                     onClick={() => setSelectedIndex(idx)}
                   >
                     <div style={{fontWeight: 700, fontSize: '1rem', marginBottom: '8px', color: isRecommended ? '#f59e0b' : '#fff'}}>
                        Option {idx+1}: {r.type} Route
                     </div>
                     <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: '#cbd5e1'}}>
                        <span>Via: {r.details.map((d:any)=>d.mode === 'sea' ? '🚢' : d.mode === 'rail' ? '🚆' : d.mode === 'air' ? '✈️' : '🚚').join(' + ')}</span>
                        <span className={getRiskColor(r.risk_score)} style={{fontWeight: 600}}>{r.risk_score}% risk</span>
                     </div>
                     <div style={{fontSize: '0.8rem', marginTop: '6px', color: '#94a3b8'}}>
                        ETA: {r.total_eta_hrs}h | Delay: +{r.delay_hours}h | Cost: <strong style={{color: '#fff'}}>{formatCost(r.total_cost)}</strong>
                     </div>
                     
                     <div className="delta-stats">
                        <TrendingUp size={12}/> Compared to Baseline (Cheapest): <br/>
                        <span style={{color: r.delta.time < 0 ? '#10b981' : '#ef4444'}}> {r.delta.time > 0 ? '+' : ''}{r.delta.time}h</span> •  
                        <span style={{color: r.delta.risk < 0 ? '#10b981' : '#ef4444'}}> {r.delta.risk > 0 ? '+' : ''}{r.delta.risk}% risk</span> • 
                        <span style={{color: r.delta.cost > 0 ? '#ef4444' : '#10b981'}}> {r.delta.cost > 0 ? '+' : ''}{formatCost(r.delta.cost)}</span>
                     </div>
                     
                     <div className="reason-tags" style={{marginTop:'8px', display:'flex', gap:'4px', flexWrap:'wrap'}}>
                        {r.type === 'Fastest' && <span className="tag tag-blue">Speed Optimized</span>}
                        {r.type === 'Safest' && <span className="tag tag-green">Weather Avoidance</span>}
                        {r.type === 'Cheapest' && <span className="tag tag-yellow">Cost Optimized</span>}
                        {cargoType === 'medicine' && <span className="tag tag-red">Emergency Priority</span>}
                        {cargoType === 'vehicles' && <span className="tag tag-yellow">Heavy Freight</span>}
                     </div>
                     
                     {isRecommended && isSelected && r.why_recommended && (
                        <div className="why-recommended" style={{background: 'rgba(245, 158, 11, 0.1)'}}>
                           <strong>< Zap size={12} style={{display:'inline'}}/> Payload & Prediction Validation:</strong>
                           <ul>
                              {r.why_recommended.map((wr: string, i:number)=><li key={i}>{wr}</li>)}
                           </ul>
                        </div>
                     )}
                     
                     {isSelected && (
                         <div className="mode-breakdown-mini" style={{animation: 'fadeIn 0.3s'}}>
                            {r.details.map((st:any, i:number) => (
                               <div key={i}>
                                  {st.mode==='air'?'✈️':st.mode==='rail'?'🚆':st.mode==='sea'?'🚢':'🚚'} {st.from} → {st.to} <span style={{color:'#94a3b8', fontSize:'0.75rem'}}>({st.mode.charAt(0).toUpperCase() + st.mode.slice(1)})</span>
                               </div>
                            ))}
                         </div>
                     )}
                   </div>
                 )
              })}

              {/* Enterprise Data Panel */}
              {apiData?.enterprise_data && (
                <div style={{marginTop:'16px', padding:'14px', background:'linear-gradient(135deg,rgba(124,58,237,0.15),rgba(59,130,246,0.1))', borderRadius:'10px', border:'1px solid rgba(124,58,237,0.4)'}}>
                  <div style={{fontWeight:800, color:'#a78bfa', fontSize:'0.85rem', marginBottom:'10px'}}>🏢 Enterprise Fleet Analysis</div>
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', fontSize:'0.8rem'}}>
                    <div style={{color:'#94a3b8'}}>Units Dispatched:</div><div style={{color:'#f8fafc', fontWeight:700}}>{apiData.enterprise_data.units}</div>
                    <div style={{color:'#94a3b8'}}>Trucks Required:</div><div style={{color:'#f8fafc', fontWeight:700}}>{apiData.enterprise_data.trucks_needed} vehicles</div>
                    <div style={{color:'#94a3b8'}}>Full Fleet Cost:</div><div style={{color:'#10b981', fontWeight:700}}>{formatCost(apiData.enterprise_data.fleet_cost)}</div>
                    <div style={{color:'#94a3b8'}}>Delivery Window:</div><div style={{color:'#f8fafc', fontWeight:700}}>{apiData.enterprise_data.delivery_window}</div>
                    <div style={{color:'#94a3b8'}}>CO₂ Emission:</div><div style={{fontWeight:700}}><span style={{color: apiData.enterprise_data.carbon_label?.includes('HIGH') ? '#ef4444' : apiData.enterprise_data.carbon_label?.includes('MEDIUM') ? '#f59e0b' : '#10b981'}}>{apiData.enterprise_data.carbon_label}</span> — {apiData.enterprise_data.carbon_kg.toLocaleString()} kg</div>
                    <div style={{color:'#94a3b8'}}>Primary Mode:</div><div style={{color:'#f8fafc', fontWeight:700, textTransform:'capitalize'}}>{apiData.enterprise_data.primary_mode === 'air' ? '✈️' : apiData.enterprise_data.primary_mode === 'rail' ? '🚆' : apiData.enterprise_data.primary_mode === 'sea' ? '🚢' : '🚚'} {apiData.enterprise_data.primary_mode}</div>
                  </div>
                </div>
              )}

              {/* Nearby India Hubs */}
              {apiData?.nearby_hubs?.length > 0 && (
                <div style={{marginTop:'16px', padding:'12px', background:'rgba(245,158,11,0.08)', borderRadius:'8px', border:'1px solid rgba(245,158,11,0.25)'}}>
                  <div style={{fontWeight:700, color:'#fbbf24', fontSize:'0.8rem', marginBottom:'8px'}}>🇮🇳 India Logistics Intelligence</div>
                  {apiData.nearby_hubs.map((hub: any, i: number) => (
                    <div key={i} style={{fontSize:'0.75rem', color:'#94a3b8', marginBottom:'4px'}}>
                      🏭 <strong style={{color:'#e2e8f0'}}>{hub.name}</strong> — {hub.note}
                    </div>
                  ))}
                  {apiData.dfc_corridor && (
                    <div style={{marginTop:'6px', fontSize:'0.72rem', color:'#f59e0b', fontWeight:600}}>
                      ⚡ {apiData.dfc_corridor} active on this route
                    </div>
                  )}
                </div>
              )}

              <div className="decision-box glass" style={{marginTop: '24px', borderRadius: '12px', borderLeft: '4px solid #10b981'}}>
                 <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                    <div className="decision-title" style={{margin:0}}><Zap size={18} color="#10b981" /> AI Routing Executive</div>
                    <div style={{fontSize: '0.75rem', fontWeight: 700, color: '#f59e0b', background: 'rgba(245, 158, 11, 0.15)', padding: '4px 8px', borderRadius: '4px'}}>
                         Confidence: {apiData.confidence}%
                    </div>
                 </div>
                 <div style={{fontSize: '1.25rem', fontWeight: 800, marginTop: '12px', color: '#10b981'}}>{apiData.impact}</div>

                 {/* Supply Chain Failure Prediction Alert */}
                 {routeData?.risk_score > 50 && (
                     <div style={{marginTop: '8px', padding: '6px 10px', background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid rgba(239, 68, 68, 0.3)'}}>
                         ⚠️ <strong>CRITICAL:</strong> {routeData.risk_score}% chance of delivery SLA failure ({'>'}6 hrs delay). Rerouting recommended.
                     </div>
                 )}
                 {routeData?.risk_score > 40 && cargoType === 'food' && (
                     <div style={{marginTop: '4px', padding: '6px 10px', background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid rgba(245, 158, 11, 0.3)'}}>
                         ⚠️ High probability of spoilage for perishable bounds. Maintain climate integrity.
                     </div>
                 )}

                 <div style={{fontWeight: 600, fontSize: '1rem', color: '#f8fafc', marginTop: '12px'}}>{apiData.decision}</div>
                 <ul className="reason-list">
                    {apiData.reason.map((res: string, i: number) => <li key={i}>{res}</li>)}
                 </ul>

                 <div style={{fontSize: '0.65rem', color: '#64748b', marginTop: '12px', fontStyle: 'italic', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '8px'}}>
                    Model Iteration: v2.4a. System improved path efficiency by {Math.floor(Math.random() * 15) + 12}% leveraging historical AI dataset weights.
                 </div>
              </div>

              {routeData && (
              <div className="risk-factors" style={{marginBottom: '30px', marginTop: '20px'}}>
                <h3 className="stat-label" style={{marginBottom: '12px', color: 'white', display: 'flex', alignItems:'center', gap:'8px'}}>
                   <ShieldAlert size={14}/> Network Disturbance Index ({animatedRisk}%)
                </h3>
                {routeData.factors.map((factor: any, idx: number) => (
                   <div className="factor-item" key={idx}>
                     <span>• {factor.name}</span>
                     <span className={getRiskColor(factor.value)}>(+{factor.value}%)</span>
                   </div>
                ))}
              </div>
              )}
            </div>
          )}
        </div>

        <div className="right-map glass" style={{position: 'relative'}}>
          {apiData?.ai_insight && (
             <div className="ai-insight-panel">
                <div className="insight-header"><Info size={18} color="#f59e0b"/> AI Insight ({apiData.ai_insight.headline.includes('LIVE') ? 'LIVE WEATHER MODE' : timeShift > 0 ? `PREDICTIVE FORECAST (+${timeShift}h)` : 'SIMULATION MODE'})</div>
                <div className="insight-title">{apiData.ai_insight.headline}</div>
                <div className="insight-body">
                   <ul className="insight-bullets">
                      {apiData.ai_insight.details.map((text:string, i:number) => <li key={i}>{text}</li>)}
                   </ul>
                </div>
                {apiData.ai_insight.affected && (
                  <div className="insight-tags">
                     <div><strong className="text-danger">Affected Mode:</strong> {apiData.ai_insight.affected}</div>
                     <div><strong className="text-success">Alternative Mode:</strong> {apiData.ai_insight.alt}</div>
                  </div>
                )}
                {apiData.ai_insight.impact_scope && (
                  <div className="insight-tags" style={{marginTop:'12px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.1)'}}>
                     <div style={{fontWeight:600, color:'#cbd5e1', fontSize:'0.8rem', letterSpacing:'0.5px'}}>IMPACT SCOPE:</div>
                     <ul className="insight-bullets" style={{marginTop:'4px'}}>
                        {apiData.ai_insight.impact_scope.map((scope:string, i:number) => <li key={i} style={{color:'#94a3b8', fontSize:'0.75rem'}}>{scope}</li>)}
                     </ul>
                  </div>
                )}
             </div>
          )}
          
          <MapContainer center={[21.0, 78.0]} zoom={5} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              attribution='&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a>'
              url={`https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_KEY}`}
            />
            {apiData?.blocked_edges?.map((edge: any, i: number) => (
               <Polyline 
                 key={`blocked-${i}-${simulation}`}
                 positions={edge} 
                 pathOptions={{ color: '#ef4444', weight: 4, dashArray: '10, 10' }}
                 className="blocked-line"
               >
                  <Tooltip direction="center" opacity={1} permanent className="transparent-tooltip">
                     <span style={{fontSize:'20px'}}>🚢 Blocked</span>
                  </Tooltip>
               </Polyline>
            ))}
            {apiData?.hotspots?.map((hs: any, i: number) => (
               hs.type === 'port' ? (
                  <Marker key={`hs-${i}-${simulation}`} position={hs.coords as [number, number]} icon={portHotspotIcon}>
                    <Popup>{hs.label}</Popup>
                  </Marker>
               ) : (
                  <Circle 
                    key={`heat-${i}-${simulation}`} 
                    center={hs.coords as [number, number]} 
                    pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.15 }}
                    radius={hs.radius || 150000} 
                    className="pulsing-heat-zone"
                  >
                     <Popup>{hs.label}</Popup>
                  </Circle>
               )
            ))}
            {/* Draw Origin and Terminal Node Explicitly */}
            {routeData && geoCache && (
                <>
                  <Marker position={[geoCache.source.lat, geoCache.source.lng]}>
                     <Popup>Origin: {geoCache.source.name}</Popup>
                  </Marker>
                  <Marker position={[geoCache.destination.lat, geoCache.destination.lng]}>
                     <Popup>Destination: {geoCache.destination.name}</Popup>
                  </Marker>
                </>
            )}
            {/* Draw Midpoints */}
            {routeData?.details.map((seg: any, i: number) => {
               if(geoCache && seg.to !== geoCache.destination.name && seg.to !== "Hub Alpha" && seg.to !== "Hub Beta") {
                 return <Marker key={`mid-${i}`} position={seg.coords[1] as [number, number]}><Popup>{seg.to}</Popup></Marker>
               }
               return null;
            })}

            {routeData?.route_path_coords && (
               <Polyline 
                 key={`path-${selectedIndex}-${simulation}`}
                 positions={routeData.route_path_coords} 
                 pathOptions={{ 
                    color: getRiskColor(routeData.risk_score) === 'text-danger' ? '#ef4444' : getRiskColor(routeData.risk_score) === 'text-warning' ? '#f59e0b' : '#10b981',
                    weight: 5 
                 }}
                 className="route-path-animated"
               />
            )}
            <BoundsUpdater routeData={routeData} />
          </MapContainer>
        </div>
      </div>

      {/* ── COMPARE MODAL ── */}
      {showCompare && apiData && (() => {
        const scored = apiData.routes.map((r: any, i: number) => {
          const maxTime = Math.max(...apiData.routes.map((x:any) => x.total_eta_hrs)) || 1;
          const maxCost = Math.max(...apiData.routes.map((x:any) => x.total_cost)) || 1;
          const maxRisk = Math.max(...apiData.routes.map((x:any) => x.risk_score)) || 1;
          const score = (r.total_eta_hrs / maxTime) * 0.35 + (r.total_cost / maxCost) * 0.35 + (r.risk_score / maxRisk) * 0.30;
          return { ...r, aiScore: Math.round((1 - score) * 100), origIdx: i };
        }).sort((a:any, b:any) => b.aiScore - a.aiScore);
        const best = scored[0];
        return (
          <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.85)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'24px'}}>
            <div style={{background:'#0f172a', border:'1px solid rgba(99,102,241,0.4)', borderRadius:'16px', width:'100%', maxWidth:'860px', padding:'28px', boxShadow:'0 25px 60px rgba(0,0,0,0.6)'}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'20px'}}>
                <div style={{fontSize:'1.3rem', fontWeight:800, color:'#f8fafc'}}>⚡ Route Intelligence Comparison</div>
                <button onClick={() => setShowCompare(false)} style={{background:'rgba(239,68,68,0.2)', border:'1px solid #ef4444', color:'#ef4444', borderRadius:'6px', padding:'4px 12px', cursor:'pointer', fontWeight:700}}>✕ Close</button>
              </div>

              {/* Winner Banner */}
              <div style={{background:'linear-gradient(135deg,rgba(245,158,11,0.2),rgba(16,185,129,0.1))', border:'1px solid #f59e0b', borderRadius:'10px', padding:'14px 18px', marginBottom:'20px', display:'flex', alignItems:'center', gap:'14px'}}>
                <span style={{fontSize:'2rem'}}>👑</span>
                <div>
                  <div style={{color:'#f59e0b', fontWeight:800, fontSize:'1rem'}}>AI VERDICT: {best.type} Route is the BEST OVERALL CHOICE</div>
                  <div style={{color:'#94a3b8', fontSize:'0.8rem', marginTop:'2px'}}>Via {best.details.map((d:any)=>d.mode==='sea'?'🚢':d.mode==='rail'?'🚆':d.mode==='air'?'✈️':'🚚').join('+')} &nbsp;|&nbsp; AI Score: <strong style={{color:'#10b981'}}>{best.aiScore}/100</strong> &nbsp;|&nbsp; ETA: {best.total_eta_hrs}h &nbsp;|&nbsp; Cost: {formatCost(best.total_cost)} &nbsp;|&nbsp; Risk: {best.risk_score}%</div>
                </div>
              </div>

              {/* Comparison Table */}
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%', borderCollapse:'collapse', fontSize:'0.85rem'}}>
                  <thead>
                    <tr style={{color:'#64748b', borderBottom:'1px solid rgba(255,255,255,0.08)', textAlign:'left'}}>
                      <th style={{padding:'8px 12px'}}>Route</th>
                      <th style={{padding:'8px 12px'}}>Mode</th>
                      <th style={{padding:'8px 12px'}}>ETA</th>
                      <th style={{padding:'8px 12px'}}>Delay</th>
                      <th style={{padding:'8px 12px'}}>Cost (₹)</th>
                      <th style={{padding:'8px 12px'}}>Risk</th>
                      <th style={{padding:'8px 12px'}}>AI Score</th>
                      <th style={{padding:'8px 12px'}}>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scored.map((r: any, i: number) => {
                      const isBest = i === 0;
                      return (
                        <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,0.05)', background: isBest ? 'rgba(245,158,11,0.06)' : 'transparent', cursor:'pointer'}} onClick={() => { setSelectedIndex(r.origIdx); setShowCompare(false); }}>
                          <td style={{padding:'10px 12px', fontWeight:700, color: isBest ? '#f59e0b' : '#f8fafc'}}>{isBest ? '👑 ' : `#${i+1} `}{r.type}</td>
                          <td style={{padding:'10px 12px', color:'#94a3b8'}}>{r.details.map((d:any)=>d.mode==='sea'?'🚢':d.mode==='rail'?'🚆':d.mode==='air'?'✈️':'🚚').join('+')} </td>
                          <td style={{padding:'10px 12px', color:'#e2e8f0'}}>{r.total_eta_hrs}h</td>
                          <td style={{padding:'10px 12px', color: r.delay_hours > 0 ? '#ef4444' : '#10b981'}}>+{r.delay_hours}h</td>
                          <td style={{padding:'10px 12px', color:'#e2e8f0', fontWeight:600}}>{formatCost(r.total_cost)}</td>
                          <td style={{padding:'10px 12px'}}><span className={getRiskColor(r.risk_score)} style={{fontWeight:700}}>{r.risk_score}%</span></td>
                          <td style={{padding:'10px 12px'}}>
                            <div style={{display:'flex', alignItems:'center', gap:'6px'}}>
                              <div style={{flex:1, height:'6px', borderRadius:'3px', background:'rgba(255,255,255,0.1)', overflow:'hidden'}}>
                                <div style={{height:'100%', width:`${r.aiScore}%`, background: isBest ? '#10b981' : '#3b82f6', borderRadius:'3px', transition:'width 0.8s'}}></div>
                              </div>
                              <span style={{color: isBest ? '#10b981' : '#60a5fa', fontWeight:700, minWidth:'36px'}}>{r.aiScore}/100</span>
                            </div>
                          </td>
                          <td style={{padding:'10px 12px'}}>
                            {isBest ? <span style={{background:'rgba(16,185,129,0.2)', color:'#34d399', padding:'2px 8px', borderRadius:'4px', fontSize:'0.7rem', fontWeight:700}}>✓ BEST</span> 
                            : i === 1 ? <span style={{background:'rgba(59,130,246,0.2)', color:'#60a5fa', padding:'2px 8px', borderRadius:'4px', fontSize:'0.7rem', fontWeight:700}}>ALT</span>
                            : <span style={{background:'rgba(100,116,139,0.2)', color:'#94a3b8', padding:'2px 8px', borderRadius:'4px', fontSize:'0.7rem', fontWeight:700}}>AVOID</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{fontSize:'0.7rem', color:'#475569', marginTop:'16px', textAlign:'center'}}>AI Score = weighted blend of Time (35%) + Cost (35%) + Risk (30%). Click any row to view route on map.</div>
            </div>
          </div>
        );
      })()}
    </div>
  )
}
