import React from 'react'
import { createRoot } from 'react-dom/client'
import { ClavisViewer } from '@artsdatabanken/clavis-viewer-web'
import key from './key.json'
createRoot(document.getElementById('root')).render(<ClavisViewer clavis={key} language="en" />)
