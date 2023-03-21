import fs from 'fs'
import path from 'path'
import axios from 'axios';

export default async function handler(req, res) {
  const { path: imageFile } = req.query;
  const name = imageFile[imageFile.length - 1];
  const filePath = path.resolve('.', 'public/images/', ...imageFile);

 let url = 'https://res.cloudinary.com/' + imageFile.join('/');
 
  url = url.replace(/e_trim[^.]+e_trim/, 'e_trim');  
  if (!fs.existsSync(filePath)) {
    console.log('downloading ' + url);
    try {
      await downloadImage(url, filePath);
    } catch (err) {
      const parts = url.split("media/catalog/product");
      const filename = parts[1];
      if (typeof filename != "undefined")  {
        let actualFile = 'https://static.mobelaris.com/media/catalog/product' + filename;
        try {
          const imageResponse = await axios.get(actualFile, { responseType: 'arraybuffer' });
          const imageBuffer = Buffer.from(imageResponse.data, 'binary');

          // Set the appropriate content-type for the image file
          res.setHeader('Content-Type', 'image/jpeg');

          // Send the image file as response
          res.send(imageBuffer);
          return;
        } catch(err) {

        }
        
      }
    }

  }

  const imageBuffer = fs.readFileSync(filePath)

  res.setHeader('Content-Type', 'image/' + name.substring(name.length - 3))
  res.send(imageBuffer)
}

const downloadImage = async (url, filePath) => {
  const response = await axios({
    url,
    responseType: 'stream',
  });

  const directoryPath = path.dirname(filePath);
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const stream = response.data.pipe(fs.createWriteStream(filePath));
    stream.on('finish', () => resolve());
    stream.on('error', e => reject(e));
  });
};
