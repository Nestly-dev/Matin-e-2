import { useCatalog, useMyList } from "../catalog.js";
import Hero from "../components/Hero.jsx";
import { Row } from "../components/Rows.jsx";
import SetupNotice from "../components/SetupNotice.jsx";

export default function HomeTab() {
  const { data, error } = useCatalog("/list/trending-today");
  const { list } = useMyList();

  if (error) {
    return (
      <>
        <div className="hero hero-empty" />
        <SetupNotice error={error} />
        {list.length > 0 && <Row title="My list" items={list} />}
      </>
    );
  }

  return (
    <>
      <Hero items={data?.results} />
      <div className="rows">
        {list.length > 0 && <Row title="My list" items={list} />}
        <Row title="Trending this week" path="/list/trending-movies" />
        <Row title="New in cinemas" path="/list/now-playing" />
        <Row title="Coming soon" path="/list/upcoming" />
        <Row title="Shows everyone's watching" path="/list/trending-tv" />
        <Row title="All-time favourites" path="/list/top-movies" />
      </div>
    </>
  );
}
