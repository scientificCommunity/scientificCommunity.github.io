hexo clean&&hexo deploy
git add .
if [ ! "$1" ]
then
  curr_date_time=$(date "+%Y-%m-%d %H:%M:%S")  
  git commit -m "auto commit $curr_date_time"
else
  git commit -m "$1" 
fi
git push

bash sync_upload.sh
