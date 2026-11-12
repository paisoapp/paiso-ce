/**
 * Theme-aware icon layer (Tier 2).
 *
 * The app imports icons from here instead of "lucide-react". This module
 * re-exports every lucide icon (so nothing can break) and OVERRIDES the
 * commonly-used ones with theme-aware wrappers:
 *
 *   • `classic` and `pixel-art` keep the original lucide icon — Pixel Art relies
 *     on the Tier-1 `crispEdges` stroke treatment in index.css.
 *   • The other 8 themes render the Phosphor equivalent at a per-theme weight
 *     (thin / light / regular / bold / fill / duotone), giving each theme a
 *     distinct icon personality while keeping identical glyph geometry.
 *
 * Geometry is preserved across themes, so recognizability/usability is intact.
 * Add a new icon by importing its Phosphor twin (Ph-prefixed) and adding one
 * `wrap(...)` line.
 */
import * as React from "react";
import * as Lucide from "lucide-react";
import {
  Archive as PhArchive, ArrowRight as PhArrowRight, ArrowSquareOut as PhArrowSquareOut,
  ArrowsClockwise as PhArrowsClockwise, ArrowsLeftRight as PhArrowsLeftRight, Bank as PhBank,
  Buildings as PhBuildings, CalendarDots as PhCalendarDots,
  Camera as PhCamera, Car as PhCar, CaretDown as PhCaretDown, CaretLeft as PhCaretLeft,
  CaretRight as PhCaretRight, CaretUp as PhCaretUp, CaretUpDown as PhCaretUpDown,
  ChartBar as PhChartBar, ChartLine as PhChartLine, ChartPieSlice as PhChartPieSlice,
  CheckCircle as PhCheckCircle, 
  ClockCounterClockwise as PhClockCounterClockwise, Copy as PhCopy, 
  Diamond as PhDiamond, DownloadSimple as PhDownloadSimple,
  Envelope as PhEnvelope, Eye as PhEye, EyeSlash as PhEyeSlash, Faders as PhFaders,
  FileArrowUp as PhFileArrowUp, GearSix as PhGearSix,
  House as PhHouse, Info as PhInfo, List as PhList, MagnifyingGlass as PhMagnifyingGlass,
  Monitor as PhMonitor, Moon as PhMoon, Package as PhPackage,
  Paperclip as PhPaperclip, PencilSimple as PhPencilSimple, PiggyBank as PhPiggyBank,
  Plus as PhPlus, Receipt as PhReceipt, Shield as PhShield,
  ShieldCheck as PhShieldCheck, ShieldSlash as PhShieldSlash, SignOut as PhSignOut,
  Sparkle as PhSparkle, SquaresFour as PhSquaresFour, Star as PhStar, Sun as PhSun,
  TrendUp as PhTrendUp, Trash as PhTrash, UploadSimple as PhUploadSimple, Users as PhUsers,
  Wallet as PhWallet, Warning as PhWarning, X as PhX, 
  type Icon as PhosphorIcon, type IconWeight,
} from "@phosphor-icons/react";
import { useThemeStore } from "@/store/theme";
import type { ThemeId } from "@/lib/themes";

// Re-export every lucide icon so any unmapped name still resolves. Explicit
// exports below shadow these for the icons we theme.
export * from "lucide-react";

/** Per-theme Phosphor weight. `lucide` = keep the original lucide icon. */
const ICON_THEME: Record<ThemeId, { lib: "lucide" } | { lib: "phosphor"; weight: IconWeight }> = {
  classic: { lib: "lucide" },
  "pixel-art": { lib: "lucide" },
  swiss: { lib: "phosphor", weight: "thin" },
  "atlas-console": { lib: "phosphor", weight: "thin" },
  plain: { lib: "phosphor", weight: "light" },
  editorial: { lib: "phosphor", weight: "light" },
  "verdant-grove": { lib: "phosphor", weight: "regular" },
  terrazzo: { lib: "phosphor", weight: "duotone" },
  "kinetic-flux": { lib: "phosphor", weight: "bold" },
  civic: { lib: "phosphor", weight: "fill" },
};

type AnyIconProps = React.SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
};

/**
 * Build a theme-aware icon from a (lucide, phosphor) pair. The public prop API
 * matches lucide (className, size, color via currentColor), so call sites are
 * unchanged — only the import path differs.
 */
function wrap(LucideIcon: React.ComponentType<any>, Phosphor: PhosphorIcon) {
  const Themed = React.forwardRef<SVGSVGElement, AnyIconProps>(function ThemedIcon(props, ref) {
    const themeId = useThemeStore((s) => s.themeId);
    const cfg = ICON_THEME[themeId] ?? { lib: "lucide" };
    if (cfg.lib === "lucide") {
      const L = LucideIcon as React.ComponentType<any>;
      return <L ref={ref} {...props} />;
    }
    // Phosphor uses `weight` rather than stroke width; drop lucide-only props.
    const { strokeWidth: _sw, absoluteStrokeWidth: _asw, ...rest } = props;
    const Ph = Phosphor as React.ComponentType<any>;
    return <Ph ref={ref} weight={cfg.weight} {...rest} />;
  });
  return Themed;
}

/* ── Themed overrides (shadow the lucide re-exports above) ─────────────────── */
export const LayoutDashboard = wrap(Lucide.LayoutDashboard, PhSquaresFour);
export const PieChart = wrap(Lucide.PieChart, PhChartPieSlice);
export const TrendingUp = wrap(Lucide.TrendingUp, PhTrendUp);
export const Receipt = wrap(Lucide.Receipt, PhReceipt);
export const ArrowLeftRight = wrap(Lucide.ArrowLeftRight, PhArrowsLeftRight);
export const Landmark = wrap(Lucide.Landmark, PhBank);
export const Settings = wrap(Lucide.Settings, PhGearSix);
export const SlidersHorizontal = wrap(Lucide.SlidersHorizontal, PhFaders);
export const LogOut = wrap(Lucide.LogOut, PhSignOut);
export const ChevronLeft = wrap(Lucide.ChevronLeft, PhCaretLeft);
export const ChevronRight = wrap(Lucide.ChevronRight, PhCaretRight);
export const ChevronDown = wrap(Lucide.ChevronDown, PhCaretDown);
export const ChevronUp = wrap(Lucide.ChevronUp, PhCaretUp);
export const ChevronsUpDown = wrap(Lucide.ChevronsUpDown, PhCaretUpDown);
export const Wallet = wrap(Lucide.Wallet, PhWallet);
export const Sun = wrap(Lucide.Sun, PhSun);
export const Moon = wrap(Lucide.Moon, PhMoon);
export const Monitor = wrap(Lucide.Monitor, PhMonitor);
export const Plus = wrap(Lucide.Plus, PhPlus);
export const Trash2 = wrap(Lucide.Trash2, PhTrash);
export const Upload = wrap(Lucide.Upload, PhUploadSimple);
export const Download = wrap(Lucide.Download, PhDownloadSimple);
export const Camera = wrap(Lucide.Camera, PhCamera);
export const Mail = wrap(Lucide.Mail, PhEnvelope);
export const Shield = wrap(Lucide.Shield, PhShield);
export const ShieldCheck = wrap(Lucide.ShieldCheck, PhShieldCheck);
export const ShieldOff = wrap(Lucide.ShieldOff, PhShieldSlash);
export const AlertTriangle = wrap(Lucide.AlertTriangle, PhWarning);
export const Info = wrap(Lucide.Info, PhInfo);
export const Users = wrap(Lucide.Users, PhUsers);
export const Copy = wrap(Lucide.Copy, PhCopy);
export const FileUp = wrap(Lucide.FileUp, PhFileArrowUp);
export const Paperclip = wrap(Lucide.Paperclip, PhPaperclip);
export const X = wrap(Lucide.X, PhX);
export const Building2 = wrap(Lucide.Building2, PhBuildings);
export const CheckCircle = wrap(Lucide.CheckCircle, PhCheckCircle);
export const Search = wrap(Lucide.Search, PhMagnifyingGlass);
export const Home = wrap(Lucide.Home, PhHouse);
export const History = wrap(Lucide.History, PhClockCounterClockwise);
export const RefreshCw = wrap(Lucide.RefreshCw, PhArrowsClockwise);
export const Eye = wrap(Lucide.Eye, PhEye);
export const EyeOff = wrap(Lucide.EyeOff, PhEyeSlash);
export const ExternalLink = wrap(Lucide.ExternalLink, PhArrowSquareOut);
export const Star = wrap(Lucide.Star, PhStar);
export const Sparkles = wrap(Lucide.Sparkles, PhSparkle);
export const Pencil = wrap(Lucide.Pencil, PhPencilSimple);
export const Package = wrap(Lucide.Package, PhPackage);
export const PiggyBank = wrap(Lucide.PiggyBank, PhPiggyBank);
export const Car = wrap(Lucide.Car, PhCar);
export const Gem = wrap(Lucide.Gem, PhDiamond);
export const Archive = wrap(Lucide.Archive, PhArchive);
export const CalendarDays = wrap(Lucide.CalendarDays, PhCalendarDots);
export const ArrowRight = wrap(Lucide.ArrowRight, PhArrowRight);
export const Menu = wrap(Lucide.Menu, PhList);
export const BarChart2 = wrap(Lucide.BarChart2, PhChartBar);
export const LineChart = wrap(Lucide.LineChart, PhChartLine);
