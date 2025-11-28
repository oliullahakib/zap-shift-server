const express = require('express')
const cors = require('cors');
require('dotenv').config()
const stripe = require('stripe')(`${process.env.PAYMENT_SECRET}`);
const admin = require("firebase-admin");
const serviceAccount = require("./zap-shift-firebase-adminsdk-.json");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express()
const port = process.env.PORT || 3000

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wfr9cox.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
// midleware 
app.use(cors())
app.use(express.json())

// cusmont middleware 
const vrifyFriebaseToken = async (req, res, next) => {
  const authorization = req.headers.authorization

  if (!authorization) {
    return res.status(401).send({ message: "unauthorize access" })
  }
  const token = authorization.split(' ')[1]

  if (!token) {
    return res.status(401).send({ message: "unauthorize access" })
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.token_email = decoded.email
    next()
  } catch (error) {
    return res.status(401).send({ message: "unauthorize access" })
  }
}

app.get('/', (req, res) => {
  res.send('zap is shifting!!')
})

// traking id generator 
function createTrackingId() {
  const prefix = 'BDX-';
  const timestampPart = Date.now().toString(36).toUpperCase();
  const randomPart = Math.random().toString(16).substring(2, 8).toUpperCase();
  return `${prefix}${timestampPart}-${randomPart}`;
}

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("Zap-Shift")
    const parcelCollection = db.collection("parcels")
    const paymentCollection = db.collection("payment")
    const usersCollection = db.collection("users")
    const riderCollection = db.collection("rider")

    // middleware with db 

    const verifyAdmin = async (req, res, next) => {
      const email = req.token_email
      const query = {}
      if (email) {
        query.email = email
      }
      const result = await usersCollection.findOne(query)
      if (result.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" })
      }
      next()
    }

    // user releted apis 
    app.get('/users', vrifyFriebaseToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray()
      res.send(result)
    })
    app.get('/user/:email/role', async (req, res) => {
      const { email } = req.params
      const query = {}
      if (email) {
        query.email = email
      }
      const result = await usersCollection.findOne(query)
      res.send({ role: result.role })
    })
    app.patch('/user/:id/role', vrifyFriebaseToken, async (req, res) => {
      const { id } = req.params
      const { role } = req.body
      const query = {}
      if (id) {
        query._id = new ObjectId(id)
      }
      const update = {
        $set: { role }
      }
      const result = await usersCollection.updateOne(query, update)
      res.send(result)
    })
    app.post('/user', async (req, res) => {
      const newUser = req.body
      newUser.createdAt = new Date()
      newUser.role = "user"
      const result = await usersCollection.insertOne(newUser)
      res.send(result)
    })

    // parcel releted apis 
    app.get('/my-parcels', vrifyFriebaseToken, async (req, res) => {
      const { email } = req.query
      const query = {}
      if (email) {
        query.senderEmail = email
      }
      const result = await parcelCollection.find(query).toArray()
      res.send(result)
    })
    app.post('/parcels', async (req, res) => {
      const newParcel = req.body
      newParcel.createdAt = new Date()
      // need to add tracking id here only 
      const trakingId = createTrackingId()
      newParcel.trakingId = trakingId;
      const result = await parcelCollection.insertOne(newParcel)
      res.send(result)
    })
    app.delete('/parcel/:id', async (req, res) => {
      const { id } = req.params
      const query = { _id: new ObjectId(id) }
      const result = await parcelCollection.deleteOne(query)
      res.send(result)
    })

    // payment related apis 

    app.post('/payment-checkout-session', async (req, res) => {
      const parcelInfo = req.body
      const { email, name, parcelId, cost } = parcelInfo
      const amount = parseInt(cost) * 100
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'USD',
              product_data: { name: name },
              unit_amount: amount
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        customer_email: email,
        metadata: {
          parcelId: parcelId,
          trakingId:parcelInfo.trakingId
        },
        success_url: `${process.env.DOMAIN_NAME}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.DOMAIN_NAME}/dashboard/payment-cancel`,
      })
      res.send({ url: session.url })
    })

    app.patch('/payment-success', async (req, res) => {
      const { session_id } = req.query
      const sessonData = await stripe.checkout.sessions.retrieve(session_id)


      // check the parcle first 
      const query = { transactionId: sessonData.payment_intent }
      const parcelExsit = await paymentCollection.findOne(query)
      if (parcelExsit) {
        return res.send({
          message: "Payment already complite for this parcel",
          transactionId: sessonData.payment_intent,
          trakingId:parcelExsit.trakingId,
        })
      }
      // modify the parcel 
      const id = sessonData.metadata.parcelId
      const trakingId = sessonData.metadata.trakingId;
      const filter = { _id: new ObjectId(id) }
      const update = {
        $set: {
          paymentStatus: sessonData.payment_status,
          trakingId,
          deliveryStatus: "pending-pickup"
        }
      }
      const modifyResult = await parcelCollection.updateOne(filter, update)

      // creat a transaciton history 
      const paymentInfo = {
        amoun: sessonData.amount_total,
        currency: sessonData.currency,
        payer_email: sessonData.customer_email,
        productId: sessonData.metadata.parcelId,
        transactionId: sessonData.payment_intent,
        paymentStatus: sessonData.payment_status,
        payAt: new Date(),
        trakingId
      }
      const paymentResult = await paymentCollection.insertOne(paymentInfo)

      res.send({
        message: "success",
        paymentResult,
        transactionId: sessonData.payment_intent,
        trakingId,
        modifyResult
      })
    })

    // rider related apis 

    app.get('/riders', vrifyFriebaseToken, verifyAdmin, async (req, res) => {
      const result = await riderCollection.find().sort({ createdAt: -1 }).toArray()
      res.send(result)
    })
    app.post('/rider', vrifyFriebaseToken, async (req, res) => {
      const newRider = req.body
      newRider.createdAt = new Date()
      newRider.status = "pending"
      if (!newRider.email) {
        return res.send({ message: "Email is requerd to apply" })
      }
      // checking the application 
      const query = {}
      if (newRider.email) {
        query.email = newRider.email
      }
      const riderExist = riderCollection.findOne(query)
      if (riderExist) {
        return res.send({ message: "Your Application already taken.Please wait for approval" })
      }
      const result = await riderCollection.insertOne(newRider)
      res.send(result)
    })

    app.delete('/rider/:id', vrifyFriebaseToken, verifyAdmin, async (req, res) => {
      const { id } = req.params
      const query = { _id: new ObjectId(id) }
      const result = await riderCollection.deleteOne(query)
      res.send(result)
    })
    app.patch('/rider/:id', vrifyFriebaseToken, verifyAdmin, async (req, res) => {
      const { id } = req.params
      console.log(req.body)
      const { status, email } = req.body
      const query = { _id: new ObjectId(id) }
      const update = {
        $set: { status }
      }
      const result = await riderCollection.updateOne(query, update)

      if (status === "accepted") {
        const query = {}
        if (email) {
          query.email = email
        }
        const updateRole = {
          $set: { role: "rider" }
        }
        const userResult = usersCollection.updateOne(query, updateRole)
      }
      res.send(result)
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
