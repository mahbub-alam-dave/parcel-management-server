const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("backend server integrated");
});

const uri = `mongodb+srv://${process.env.PROFAST_USER}:${process.env.PROFAST_PASS}@mydatabase.sr7puaa.mongodb.net/?retryWrites=true&w=majority&appName=MyDatabase`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});


const decodedFirebaseAdminKey = Buffer.from(process.env.FIREBASE_ADMIN_KEY, 'base64').toString("utf8")

var admin = require("firebase-admin");

var serviceAccount = JSON.parse(decodedFirebaseAdminKey)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const parcelCollection = client.db("ProFastDB").collection("parcels");
    const paymentCollection = client.db("ProFastDB").collection("payments");
    const usersCollections = client.db("ProFastDB").collection("users")
    const ridersCollections = client.db("ProFastDB").collection("riders")
    const trackingsCollections = client.db("ProFastDB").collection("trackings")

    // custom middleware
    const verifyFirebaseToken = async (req, res, next) => {
      const accessToken = req?.headers?.authorization
      // console.log("token", accessToken)

      if(!accessToken) {
        res.status(400).send({message: "Unauthorized access"})
      }

      const token = accessToken.split(' ')[1]
      if(!token){
        res.status(400).send({message: "Unauthorized access"})
      }

      // verify token
      try {
        const decoded = await admin.auth().verifyIdToken(token)
        req.decoded = decoded
        next()
      }
      catch(error) {
        res.status(403).send({message: "forbidden"})
      }
    }

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = {userEmail: email}
      const user = await usersCollections.findOne(query)
      if(!user || user.role !== "admin") {
        return res.status(403).send({message: "Forbidden Access"})
      }

      next()
    }

    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = {userEmail: email}
      const user = await usersCollections.findOne(query)
      if(!user || user.role !== "rider") {
        return res.status(403).send({message: "Forbidden Access"})
      }

      next()
    }

    // store users info
    app.post("/users", async (req, res) => {
      const email = req.body.userEmail;
      const existUsers = await usersCollections.findOne({userEmail: email})

      if(existUsers) {
        const lastLoggedIn = req.body.lastLoggedIn;
        const update = await usersCollections.updateOne({userEmail: email}, {$set:{lastLoggedIn: lastLoggedIn}})
        return res.status(200).send({message: "Users already exists", inserted: false})
      }
      const user = req.body;
      const result = await usersCollections.insertOne(user)
      res.send(result)

    })


    // get my parcels by email query
    app.get("/parcels", verifyFirebaseToken, async (req, res) => {
      const {email, paymentStatus, deliveryStatus} = req.query;

      try {

        let query ={}
        if(email) {
          query = {email}
        }

        if(paymentStatus) {
          query.paymentStatus = paymentStatus
        }

        if(deliveryStatus) {
          query.deliveryStatus = deliveryStatus
        }

/*         if (!userEmail) {
          return res
            .status(400)
            .send({ message: "Email query parameter is required" });
        } */

        // const query = userEmail ? { email: userEmail } : {};
        // const query =  { email: userEmail }
/*         const options = {
          sort: { creationDate: -1 },
        }; */

        const parcels = await parcelCollection.find(query).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels", error);
        res.status(500).send({ message: "failed to get parcels" });
      }
    });

    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;

        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("error inserting parcel:", error);
        res.status(500).send({ message: "failed to create parcel" });
      }
    });

    
    app.delete("/parcels/:id", async (req, res) => {
      const { id } = req.params;

      try {
        const deletedParcel = await parcelCollection.deleteOne({_id: new ObjectId(id)});

        if(deletedParcel.deletedCount) {
          res.send(deletedParcel)
        }

      } catch (error) {
        console.error("Error deleting parcel:", error.message);
        res.status(500).json({
          success: false,
          message: "Server error while deleting parcel.",
        });
      }
    });


    app.get('/parcels/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });

    if (!parcel) {
      return res.status(404).json({ message: 'Parcel not found' });
    }

    res.status(200).json(parcel);

  } catch (error) {
    res.status(500).json({ message: 'Error fetching parcel', error: error.message });
  }
});

// image upload 
// app.post('/')


// payment method 
app.post('/create-payment-intent', async (req, res) => {
  const amountInCents = req.body.amountInCents;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents, // Amount in cents
      currency: 'usd',
      payment_method_types: ['card']
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// payment history and payment status
app.post('/payments', async (req, res) => {
  const { userEmail, parcelId, amount, transactionId, date } = req.body;

  try {

    const updateStatus = await parcelCollection.updateOne(
      {_id: new ObjectId(parcelId)}, {$set: { paymentStatus: "paid" }})

      if(updateStatus.modifiedCount === 0) {
        return res.status(404).send({message: 'parcel not found'})
      }

    const result = await paymentCollection.insertOne({
      userEmail,
      parcelId,
      amount,
      transactionId,
      paid_at_string: new Date().toISOString(),
      date: date || new Date(),
    });

    res.status(201).json({ message: 'Payment record saved', paymentId: result.insertedId });

  } catch (error) {
    res.status(500).json({ message: 'Error saving payment record', error: error.message });
  }
});

// GET /api/payments/user/:email
app.get('/payments', verifyFirebaseToken, async(req, res) => {

  const email = req.query.email;
  if(req.decoded.email !== email) {
    res.status(403).send({message: "Forbidden Access"})
  }
  
  // console.log('received query email', )
  try {
    const query = { userEmail: email}
    const options = {sort: {paid_at_string: -1}}

    const payments = await paymentCollection.find(query, options).toArray();

    res.status(200).json(payments);

  } catch (error) {
    res.status(500).json({ message: 'Error fetching payments', error: error.message });
  }
});

// tracking
app.get('/tracking', async(req, res) => {
  const {tracking_id, parcel_id, paymentStatus, deliverStatus, message, updated_by='' } = req.body;

  const trackingParcel = {
    tracking_id,
    parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
    paymentStatus,
    deliverStatus,
    message,
    time: new Date(),
    updated_by
  }
  const result = await trackingCollection.insertOne(trackingParcel)
  res.send(result)
})

// add riders to database
app.post('/riders', async (req, res) => {
  const rider = req.body;
  const result = await ridersCollections.insertOne(rider)
  res.send(result)
})

// GET riders with status 'pending'
app.get("/pending-riders", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const pendingRiders = await ridersCollections.find({ status: "pending" }).toArray();
    res.status(200).json(pendingRiders);
  } catch (error) {
    console.error("Failed to fetch pending riders", error);
    res.status(500).json({ message: "Server error fetching pending riders" });
  }
});

app.get('/active-riders', verifyFirebaseToken, verifyAdmin, async (req, res) => {

  try {
    const query = {status: "approved"}
    const {district} = req.query;
    if(district) {
      query.district = district
    }
    // console.log(district)

    const pendingRiders = await ridersCollections.find(query).toArray();
    res.status(200).json(pendingRiders);
  } catch (error) {
    console.error("Failed to fetch active riders", error);
    res.status(500).json({ message: "Server error fetching active riders" });
  }
})

// PATCH parcel’s deliveryStatus & assignedRiderId
app.patch('/parcels/:id/assign-rider', async (req, res) => {
  const { id } = req.params;
  const { riderId, riderEmail } = req.body;

  try {
    const result = await parcelCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          deliveryStatus: "rider_assigned",
          assignedRiderId: new ObjectId(riderId),
          assignedRiderEmail: riderEmail
        },
      }
    );
    res.send(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to assign rider" });
  }
});

app.patch('/riders/:id/set-busy', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await ridersCollections.updateOne(
      { _id: new ObjectId(id) },
      { $set: { currentStatus: "busy" } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to update rider status" });
  }
});



app.patch('/riders/:id/newStatus', async(req, res) => {
  const {id} =  req.params;
  const {status, email} = req.body;
  try {
    const result = await ridersCollections.updateOne({_id: new ObjectId(id)}, {$set:{status}})
  res.send(result)

  if(status === "approved"){
    const query = {userEmail: email}
    const updatedDoc = {
      $set: {
        role: "rider"
      }
    }
    const result = await usersCollections.updateOne(query, updatedDoc)
  }
  }
  catch(error) {
    res.status(500).send({message: "failed to update rider status"})
  }
})


// admin set role by searching users
app.get("/users/search", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).send({ message: "Query required" });

  const result = await usersCollections.find({
    $or: [
      { userEmail: { $regex: query, $options: "i" } },
      { userName: { $regex: query, $options: "i" } }
    ]
  }).limit(10).toArray();

  if (!result) {
    return res.status(404).send({ message: "User not found" });
  }

  res.send(result);
});

app.patch("/users/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!role) {
    return res.status(400).send({ message: "Role value is required" });
  }

  try {
    const result = await usersCollections.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).send({ message: "User not found or role unchanged" });
    }

    res.send({ message: "User role updated successfully", result });
  } catch (error) {
    console.error("Failed to update user role", error);
    res.status(500).send({ message: "Failed to update user role" });
  }
});

// check user role
app.get("/users/role", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).send({ message: "Email query parameter is required" });
  }

  try {
    const user = await usersCollections.findOne({ userEmail: email });

    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send({ role: user.role || "user" });
  } catch (error) {
    console.error("Failed to fetch user role", error);
    res.status(500).send({ message: "Failed to fetch user role" });
  }
});


// get parcels by assigned rider id
app.get('/rider-parcels-by-email', verifyFirebaseToken, verifyRider, async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ message: "Missing riderId query parameter" });
  }

  try {
    const parcels = await parcelCollection
      .find({
        assignedRiderEmail: email,
        deliveryStatus: { $in: ["in_transit", "rider_assigned"] },
      })
      // .sort({ creationDate: -1 })
      .toArray();

    res.status(200).json(parcels);
  } catch (error) {
    console.error("Failed to fetch rider's parcels", error);
    res.status(500).json({ message: "Server error fetching parcels" });
  }
});


app.patch('/parcels/:id/update-delivery-status', async (req, res) => {
  const { id } = req.params;
  const { newStatus } = req.body;

  try {
    const updateFields = { deliveryStatus: newStatus };

    if(newStatus === "in_transit") {
      updateFields.pickUpAt = new Date().toISOString()
    }

    if (newStatus === "delivered") {
      updateFields.isWithdrawn = false;
      updateFields.deliveredAt = new Date().toISOString()
    }
    const result = await parcelCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );

    res.send(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to update delivery status" });
  }
});

app.get('/completed-deliveries', verifyFirebaseToken, verifyRider, async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ message: "Missing email query parameter" });
  }

  try {
    const completedParcels = await parcelCollection
      .find({
        assignedRiderEmail: email,
        deliveryStatus:  { $in: ["delivered", "service_center_delivered"]},
      })
      .sort({ creationDate: -1 })
      .toArray();

    res.status(200).json(completedParcels);
  } catch (error) {
    console.error("Failed to fetch completed deliveries", error);
    res.status(500).json({ message: "Server error fetching completed deliveries" });
  }
});


app.patch('/withdraw-earnings', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Missing rider email" });
  }

  try {
    const result = await parcelCollection.updateMany(
      {
        assignedRiderEmail: email,
        deliveryStatus: { $in: ["delivered", "service_center_delivered"] },
        isWithdrawn: false,
      },
      { $set: { isWithdrawn: true } }
    );

    console.log("Pending cashouts for", email, "=>", result.length);
    res.send(result);
  } catch (error) {
    console.error("Failed to withdraw earnings", error);
    res.status(500).json({ message: "Server error while withdrawing earnings" });
  }
});

// get tracking parcel info
app.get('/tracking/:trackingId', async (req, res) => {
  const { trackingId } = req.params;

  try {
    // Find the parcel first
    const parcel = await parcelCollection.findOne({ trackingId });
    if (!parcel) {
      return res.status(404).send({ message: "Parcel not found" });
    }

    // Fetch all tracking logs for that parcel, ordered by time ascending
    const logs = await trackingsCollections
      .find({ parcelId: parcel._id })
      .sort({ createdAt: 1 })
      .toArray();

    res.send({
      trackingId: trackingId,
      parcelInfo: {
        parcelName: parcel.parcelName,
        senderName: parcel.senderName,
        receiverName: parcel.receiverName,
        deliveryStatus: parcel.deliveryStatus,
        paymentStatus: parcel.paymentStatus,
        createdAt: parcel.creationDate
      },
      trackingLogs: logs
    });

  } catch (error) {
    console.error("Error fetching tracking info", error);
    res.status(500).send({ message: "Failed to fetch tracking data" });
  }
});


// store tracking step by step
app.post('/tracking', async (req, res) => {
  const { trackingId, trackingStatus, message, updatedBy, email } = req.body;

  try {
    // Find the parcel by trackingId
    const parcel = await parcelCollection.findOne({ trackingId });
    if (!parcel) {
      return res.status(404).send({ message: "Parcel not found" });
    }

    // Create a new tracking log entry
    const newTrackingLog = {
      parcelId: parcel._id,
      trackingId,
      trackingStatus,
      message,
      createdAt: new Date(),
      updatedBy: updatedBy || "System",
      email
    };

    // Insert into tracking collection
    const result = await trackingsCollections.insertOne(newTrackingLog);

    res.status(201).send({
      message: "Tracking log added successfully",
      insertedId: result.insertedId
    });

  } catch (error) {
    console.error("Failed to insert tracking log", error);
    res.status(500).send({ message: "Failed to add tracking log" });
  }
});


// overview for admin
app.get('/parcels-dashboard-stats', async (req, res) => {
  try {
    const pipeline = [
      {
        $facet: {
          deliveryStatusStats: [
            {
              $group: {
                _id: "$deliveryStatus",
                count: { $sum: 1 }
              }
            },
            {
              $project: {
                status: "$_id",
                count: 1,
                _id: 0
              }
            }
          ],
          paymentStatusStats: [
            {
              $group: {
                _id: "$paymentStatus",
                count: { $sum: 1 }
              }
            },
            {
              $project: {
                status: "$_id",
                count: 1,
                _id: 0
              }
            }
          ]
        }
      }
    ];
    const result = await parcelCollection.aggregate(pipeline).toArray()
    res.send(result)
  }
  catch(error) {

  }
})



// get riders by filtering district location for assigning parcel
/* app.get("/active-riders", async (req, res) => {
  try {
    const { district } = req.query;

    let query = { status: "active" };
    if (district) {
      query.district = district;
    }

    const result = await ridersCollections.find(query).toArray();
    res.status(200).json(result);
    console.log(result)
  } catch (error) {
    console.error("Failed to fetch active riders", error);
    res.status(500).json({ message: "Server error fetching active riders" });
  }
}); */


// get parcels with payment_status and delivery status 
/* app.get("/parcels-assignable", async (req, res) => {
  try {
    const parcels = await parcelCollection
      .find({ paymentStatus: "paid", deliveryStatus: "not Collected" })
      .toArray();
    res.send(parcels);
  } catch (error) {
    console.error("Error fetching assignable parcels:", error);
    res.status(500).send({ message: "Failed to fetch parcels" });
  }
}); */



    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(` app is listening on port ${port}`);
});



/* 
app.get("/admin/dashboard-stats", async (req, res) => {
  try {
    // 📦 Total Parcels Count
    const totalParcels = await parcelCollection.estimatedDocumentCount();

    // 📦 Parcels Count by Payment Status
    const paymentPaidParcels = await parcelCollection.countDocuments({ paymentStatus: "paid" });
    const paymentUnpaidParcels = await parcelCollection.countDocuments({ paymentStatus: { $ne: "paid" } });

    // 📦 Parcels Created Today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayParcels = await parcelCollection.countDocuments({
      creationDate: { $gte: today }
    });

    // 📦 Parcels Created This Week
    const startOfWeek = new Date();
    startOfWeek.setDate(today.getDate() - today.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const weekParcels = await parcelCollection.countDocuments({
      creationDate: { $gte: startOfWeek }
    });

    // 📦 Parcels Created This Month
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const monthParcels = await parcelCollection.countDocuments({
      creationDate: { $gte: startOfMonth }
    });

    // 📦 Parcels Count by Delivery Status (Aggregation)
    const parcelsByDeliveryStatus = await parcelCollection.aggregate([
      {
        $group: {
          _id: "$deliveryStatus",
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          status: "$_id",
          count: 1,
          _id: 0
        }
      }
    ]).toArray();

    // 🧑‍✈️ Total Riders Count
    const totalRiders = await ridersCollections.estimatedDocumentCount();

    // 🧑‍✈️ Riders Count by Status
    const ridersByStatus = await ridersCollections.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          status: "$_id",
          count: 1,
          _id: 0
        }
      }
    ]).toArray();

    // 👥 Total Users Count
    const totalUsers = await usersCollections.estimatedDocumentCount();

    // 💵 Total Payments Count
    const totalPayments = await paymentCollection.estimatedDocumentCount();

    // ✅ Send Combined Dashboard Stats Response
    res.status(200).json({
      parcels: {
        total: totalParcels,
        paymentPaid: paymentPaidParcels,
        paymentNotPaid: paymentUnpaidParcels,
        createdToday: todayParcels,
        createdThisWeek: weekParcels,
        createdThisMonth: monthParcels,
        byDeliveryStatus: parcelsByDeliveryStatus
      },
      riders: {
        total: totalRiders,
        byStatus: ridersByStatus
      },
      users: totalUsers,
      payments: totalPayments
    });

  } catch (error) {
    console.error("Failed to fetch dashboard stats", error);
    res.status(500).json({ message: "Failed to load dashboard stats" });
  }
});
 */
