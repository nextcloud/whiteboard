import express from 'express'

const app = express()

app.get('/', (req, res) => {
	res.send('Excalidraw collaboration server is up :)')
})

export default app
