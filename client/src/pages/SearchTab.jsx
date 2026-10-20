import { useSearchParams } from "react-router-dom";
import { useCatalog } from "../catalog.js";
import { Grid } from "../components/Rows.jsx";
import SetupNotice from "../components/SetupNotice.jsx";

export default function SearchTab() {
  const [params] = useSearchParams();
  const q = (params.get("q") || "").trim();
  const { data, error, loading } = useCatalog(q ? `/search?q=${encodeURIComponent(q)}` : null);
  const items = data?.results || [];

  return (
    <div className="catalog-page">
      <div className="catalog-head">
        <h1>{q ? `Results for “${q}”` : "Search"}</h1>
      </div>
      {error ? <SetupNotice error={error} />
        : loading ? <p className="hint">Searching…</p>
        : q && items.length === 0 ? <p className="hint">Nothing found for “{q}”. Try the original title, or fewer words.</p>
        : <Grid items={items} />}
    </div>
  );
}
