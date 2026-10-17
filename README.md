# Pump-Free Single-Phase Immersion Cooling Combined with Heat Pipes

[THERM CORE Dashboard & ESP32 Integration Guide](README.net.md) 
[Undergraduate thesis](essay.pdf) 

https://github.com/user-attachments/assets/95db2ce8-414f-4e5a-9532-949ecefda8bf



**Experimental investigation and COMSOL simulation of a low-energy, pump-free electronic cooling system**

**National Sun Yat-sen University · Department of Mechanical and Electro-Mechanical Engineering**  
**Researchers:** Rui-Jie Li (李睿捷), Hsu-Hsiang Yu (游許祥)  
**Advisor:** Prof. Chen-Kun Kuo (郭振坤)

## Overview 

This project investigates a **pump-free single-phase immersion cooling** architecture for high-power electronics. A 100 W PTC heater is immersed in dielectric coolant (EC-110). A low-power submerged fan mixes the coolant, while six finned heat pipes carry heat out of the tank to an air-cooled condenser region. The system is evaluated experimentally and using COMSOL Multiphysics.

**Main finding:** With heat pipes and the internal fan at 100% duty, the heater reached a steady-state peak temperature of **61.1 °C** after approximately **1,500 s**. Without heat pipes, the temperature reached **82.3 °C after 480 s** with the internal fan at 100%, and was still rising. These observations are from different time points and should not be interpreted as a matched steady-state temperature reduction.

## 1. Cooling mechanism

```text
100 W PTC heater
      │ heat transfer to surrounding dielectric liquid
      ▼
EC-110 immersion coolant ◄── low-power internal stirring fan
      │                        (mixing and boundary-layer disruption)
      ▼
Heat-pipe evaporators (submerged)
      │ evaporation → vapor transport → condensation
      │ wick-assisted liquid return inside heat pipes
      ▼
Heat-pipe condensers (above liquid)
      │ aluminum blocks + fins
      ▼
3 W external fan → ambient air
```

- **Single-phase immersion:** EC-110 remains liquid in the immersion tank; the heater transfers heat directly to the dielectric liquid. Natural convection and local fan-driven mixing redistribute the energy.
- **Heat-pipe phase change:** The working fluid *inside each heat pipe* evaporates at the hot end, flows toward the condenser, releases latent heat, and returns through the wick. This internal phase change does **not** make the immersion coolant a two-phase system.
- **Internal mixing:** A 0.48 W fan promotes local circulation, reduces thermal stratification and disrupts the thermal boundary layer near the heater.
- **External heat rejection:** Aluminum fin assemblies increase surface area at the condenser; a 3 W external fan enhances convection to ambient air. No external coolant circulation pump is used.

## 2. Coolant: EC-110

The experiment uses **EC-110 dielectric coolant** from Engineered Fluids, selected for electrical insulation, thermal properties, and suitability for low-flow immersion cooling.

| Property | Value reported in thesis | Unit / note |
|---|---:|---|
| Thermal conductivity | 0.1363 | W/(m·K) |
| Specific heat capacity | 2.2877 | kJ/(kg·K) |
| Density | 0.82 | g/cm³ (equivalent to ~820 kg/m³; the thesis table prints `0.82 kg/m³`, apparently a unit typo) |
| Kinematic viscosity | 4.44 | cSt (= mm²/s) |
| Volumetric thermal expansion coefficient | 0.00067 | K⁻¹ |
| Dielectric strength | >60 | kV (test geometry not specified in thesis) |
| Global warming potential (GWP) | 0 | As reported in thesis |

*Properties depend on temperature and manufacturer test conditions; consult the current coolant datasheet before design or procurement.*

## 3. Components and dimensions

| Component | Material / specification | Quantity | Dimensions / power |
|---|---|---:|---|
| Heater | PTC heater, CPU heat-load surrogate | 1 | **40 × 40 mm**, **100 W** |
| Heat pipes | Cylindrical heat pipes | **6** | **Ø8 × 200 mm** each; rated ~**80 W** per pipe (supplier nominal rating) |
| Heat-pipe fin assemblies | Two heat pipes per assembly | **3 assemblies** | 2 heat pipes + aluminum connector + fins per assembly |
| Connector blocks | Aluminum | **3** | **32 × 32 × 40 mm** each; two Ø8 mm holes per block |
| Fins | Aluminum | Four fin-bearing sides per block | Individual fin face specified as **32 × 40 mm**; thickness, spacing, and fin count not specified |
| Internal stirring fan | Delta AFB0412HA | 1 | **0.48 W**; PWM-controlled |
| External cooling fan | Forced-air condenser cooling | 1 set | **3 W**, fixed output |
| Temperature sensor | Thermistor + voltage divider | 1 measurement system | Heater surface; ESP32 ADC |
| Controller | ESP32 with Wi-Fi | 1 | Temperature acquisition / cloud logging / LED indication |
| Indicator | WS2812B addressable LEDs | 1 strip | Temperature-dependent color |
| Coolant tank | Immersion enclosure | 1 | Exact tank dimensions and coolant volume **not specified** in the thesis |

Theoretical combined nominal heat-pipe capacity: `6 × 80 W = 480 W`. **This is a sum of individual nominal ratings, not a measured system-level dissipation capacity.** Actual performance depends on orientation, wick limits, interfaces, and condenser cooling.

> **Modeling note:** The thesis also describes a *separate proposed 2D heat-pipe numerical model* of length 150 mm and outer radius 10 mm (3 mm wick and 1 mm wall). Do not confuse these simulation-model dimensions with the **Ø8 × 200 mm experimental heat pipes**.

## 4. Governing equations and performance metrics

The following standard heat-transfer relationships explain the system and help interpret measurements. They are not all independently fitted or validated in the thesis.

### Heater heat flux

$$
q''=\frac{Q}{A}=\frac{100\ \mathrm{W}}{(0.04\ \mathrm{m})(0.04\ \mathrm{m})}
=62{,}500\ \mathrm{W/m^2}=6.25\ \mathrm{W/cm^2}
$$

### Convection and thermal resistance

$$
Q_{\mathrm{conv}}=hA(T_s-T_\infty),\qquad
R_{\mathrm{th}}=\frac{\Delta T}{Q},\qquad
R_{\mathrm{conv}}=\frac{1}{hA}
$$

### Conduction and dimensionless convection

$$
Q_{\mathrm{cond}}=kA\frac{\Delta T}{L},\qquad
\mathrm{Nu}=\frac{hL}{k},\qquad
\mathrm{Re}=\frac{\rho UL}{\mu}
$$

### Transient heat balance (lumped illustrative form)

$$
C_{\mathrm{eff}}\frac{dT}{dt}=Q_{\mathrm{heater}}-Q_{\mathrm{rejected}}
$$

At thermal steady state, energy accumulation tends to zero, so heat rejection approaches the total heat input (subject to other heat sources and losses).

### Relative simulation error

$$
\varepsilon=\frac{|T_{\mathrm{sim}}-T_{\mathrm{exp}}|}{T_{\mathrm{exp}}}\times100\%
$$

The thesis reports a simulated peak temperature of **59 °C** and an experimental steady-state peak of **61.1 °C**. Direct substitution of those Celsius values gives **~3.44%**, although the thesis states **<3%**; the discrepancy should be resolved before citing a precise validation percentage.

### Power usage effectiveness (PUE)

$$
\mathrm{PUE}=\frac{P_{\mathrm{total\ facility}}}{P_{\mathrm{IT\ equipment}}}
$$

PUE is a **facility-level** metric. This bench experiment demonstrates a low-power cooling concept but does not, by itself, establish a measured data-center PUE.

## 5. Experimental method

The principal experimental variables were **heat-pipe presence** (installed / absent) and **internal fan output** (50% / 100%). The heater was operated at 100 W with EC-110 coolant; external condenser fan power was kept at 3 W. Heater-surface temperature was recorded over time to assess heat accumulation and steady-state behavior.

## 6. Experimental results

| Heat pipes | Internal fan setting | Heater-surface temperature | Observation |
|---|---|---|---|
| Installed | 100% | **61.1 °C** | Steady state after ~1,500 s |
| Installed | 50% | **68.7 °C** | Steady state after ~1,350 s |
| Absent | 100% | **82.3 °C** | At 480 s; still rising |
| Absent | 50% | **84.6 °C** | At 480 s; still rising |

**Interpretation:** The heat pipes provide the critical heat-rejection path to ambient air. Internal stirring further enhances heat transfer; at steady state with heat pipes installed, increasing the fan setting from 50% to 100% lowered the reported peak temperature by **7.6 °C**.

### COMSOL simulation

The thesis describes a three-dimensional, steady-state, incompressible coolant-flow analysis using an **RNG k–ε turbulence model** and a heat-transfer model. The reported simulated peak heater temperature is **59 °C**. See the full thesis for modeling assumptions and figures; this repository README does not imply that all simulation source files are included.

## 7. ESP32 monitoring and cloud logging

```text
Thermistor → resistor divider → ESP32 ADC
                                ├─→ serial monitoring
                                ├─→ WS2812B temperature color indicator
                                └─→ Wi-Fi → ThingSpeak temperature history
```

The experimental report describes an ESP32-based temperature monitoring system with thermistor sensing, WS2812B visualization, and ThingSpeak logging. Firmware, Wi-Fi credentials, and cloud API keys should be managed separately; **never commit live passwords or ThingSpeak Write API keys to a public repository**.

## 8. Full undergraduate thesis

**熱管結合單相浸沒式冷卻之模擬與實作**  
Authors: 李睿捷、游許祥 · Advisor: 郭振坤博士  
[Read the full thesis (PDF)](essay.pdf)

The PDF contains literature review, design methods, experimental photographs, result plots, simulation figures, discussion, and references. Values in this README are based on the thesis; where the thesis contains conflicting figures, the detailed results and figure captions are used, and discrepancies are explicitly noted.

## License and attribution

See the repository's existing `LICENSE` file for code licensing. The license status of the **thesis PDF, figures, and third-party images** should be confirmed separately before redistributing or reusing them.
