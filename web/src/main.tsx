import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import "./app.js"
import Finished from "./finished"

// The page itself is plain DOM (app.js); React owns only the finished-videos carousel.
createRoot(document.getElementById("finished")!).render(
  <StrictMode>
    <Finished />
  </StrictMode>,
)
