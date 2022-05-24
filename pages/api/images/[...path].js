// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import fs from 'fs'
import path from 'path'
import axios from 'axios';

export default async function handler(req, res) {
    const {path: imageFile} = req.query;
  const name = imageFile[imageFile.length - 1];
  
  let url = 'https://res.cloudinary.com/' + imageFile.join('/');

  try {
    fs.readFileSync(path.resolve('.', 'public/images/' + name))
  } catch (error) {
    console.log('downloading');
    await download_image(url, 'public/images/'+name);
  }
  
  const filePath = path.resolve('.', 'public/images/' + name)
  const imageBuffer = fs.readFileSync(filePath)

  res.setHeader('Content-Type', 'image/' + name.substring(name.length - 3))
  res.send(imageBuffer)
  }
  

  const download_image = (url, image_path) =>
  axios({
    url,
    responseType: 'stream',
  }).then(
    response =>
      new Promise((resolve, reject) => {
        response.data
          .pipe(fs.createWriteStream(image_path))
          .on('finish', () => resolve())
          .on('error', e => reject(e));
      }),
  );
