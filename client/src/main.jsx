import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import BrowseLayout from "./components/BrowseLayout.jsx";
import HomeTab from "./pages/HomeTab.jsx";
import CatalogTab from "./pages/CatalogTab.jsx";
import TogetherTab from "./pages/TogetherTab.jsx";
import SearchTab from "./pages/SearchTab.jsx";
import Room from "./pages/Room.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import "./styles.css";
import "./browse.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <BrowserRouter>
      <Routes>
        <Route element={<BrowseLayout />}>
          <Route path="/" element={<HomeTab />} />
          <Route path="/movies" element={<CatalogTab key="movie" type="movie" />} />
          <Route path="/tv" element={<CatalogTab key="tv" type="tv" />} />
          <Route path="/together" element={<TogetherTab />} />
          <Route path="/search" element={<SearchTab />} />
        </Route>
        <Route path="/room/:roomId" element={<Room />} />
      </Routes>
    </BrowserRouter>
  </ErrorBoundary>
);
